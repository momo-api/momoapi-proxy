"""Normal binary local-only acceptance. No GUI probe, real key, network mock or disk profile."""
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import os
from pathlib import Path
import queue
import signal
import socket
import subprocess
import threading
import tempfile
import time
from urllib.parse import urlsplit


SYNTHETIC_KEY = "synthetic-normal-binary-acceptance-only"
CONFIG = {"Endpoint": "https://localhost", "APIKey": SYNTHETIC_KEY}


def require(condition, message):
    # Never print response bodies, connection handoffs, supplied keys or stderr.
    if not condition:
        raise RuntimeError("normal binary acceptance: " + message)


def check_invalid_inputs(binary):
    for data in (b"", b"{", b"{}", json.dumps({**CONFIG, "unexpected": True}).encode(),
                 json.dumps(CONFIG).encode() + b"{}", b" " * 8193,
                 json.dumps({**CONFIG, "Endpoint": "http://localhost"}).encode(),
                 json.dumps({**CONFIG, "Endpoint": "https://127.0.0.1"}).encode(),
                 json.dumps({**CONFIG, "APIKey": ""}).encode(),
                 json.dumps({**CONFIG, "APIKey": SYNTHETIC_KEY + "\n"}).encode()):
        result = subprocess.run([str(binary), "serve"], input=data,
                                capture_output=True, timeout=8)
        require(result.returncode == 1 and result.stdout == b"", "invalid config was accepted")
        require(SYNTHETIC_KEY.encode() not in result.stderr, "invalid config exposed key")


def check_readonly_mcp(binary):
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "gateway_capabilities", "arguments": {}}},
        {"jsonrpc": "2.0", "id": 4, "method": "resources/read", "params": {"uri": "momo://preview/skill"}},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "run_shell", "arguments": {"key": SYNTHETIC_KEY}}},
    ]
    data = ("\n".join(json.dumps(message) for message in messages) + "\n").encode()
    result = subprocess.run([str(binary), "mcp"], input=data, capture_output=True, timeout=8)
    require(result.returncode == 0 and result.stderr == b"", "read-only MCP startup")
    require(SYNTHETIC_KEY.encode() not in result.stdout, "MCP echoed sensitive input")
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    require([reply["id"] for reply in replies] == [1, 2, 3, 4, 5], "MCP IDs/notification contract")
    require(replies[0]["result"]["protocolVersion"] == "2024-11-05", "MCP negotiation")
    require([tool["name"] for tool in replies[1]["result"]["tools"]] == ["gateway_capabilities"], "MCP tool whitelist")
    capability = json.loads(replies[2]["result"]["content"][0]["text"])
    require(capability["media"] is False and capability["account_wallet"] is False, "MCP unsupported claims")
    require("MOMO local gateway preview" in replies[3]["result"]["contents"][0]["text"], "MCP Skill resource")
    require(replies[4]["error"]["code"] == -32602, "MCP arbitrary execution allowed")


def check_media_metadata(binary, command, modality, prelude=b"", env=None):
    meta = {"callId": SYNTHETIC_KEY, "threadId": SYNTHETIC_KEY,
            "sessionId": SYNTHETIC_KEY, "windowId": SYNTHETIC_KEY,
            "itemId": SYNTHETIC_KEY, "x-codex-turn-metadata": {"synthetic": True},
            "progressToken": 9007199254740993, "confirmed": True}
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "gateway_capabilities", "arguments": {}, "_meta": meta}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": modality + "_capabilities", "arguments": {}, "_meta": meta}},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": modality + "_generate", "arguments": {"request": {}}, "_meta": meta}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": modality + "_capabilities", "arguments": {}, "_meta": None}},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": modality + "_capabilities", "arguments": {}, "_meta": {"progressToken": []}}},
        {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": modality + "_capabilities", "arguments": {}, "_meta": meta, "extra": True}},
    ]
    data = prelude + (chr(10).join(json.dumps(m) for m in messages) + chr(10)).encode()
    result = subprocess.run(command, input=data, env=env, capture_output=True, timeout=8)
    require(result.returncode == 0 and result.stderr == b"", "media metadata startup/EOF")
    require(SYNTHETIC_KEY.encode() not in result.stdout and b'progressToken' not in result.stdout,
            "media metadata reflection")
    if env and env.get("MOMO_LOCAL_API_KEY"):
        require(env["MOMO_LOCAL_API_KEY"].encode() not in result.stdout, "media metadata token reflection")
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    require([r["id"] for r in replies] == [m["id"] for m in messages], "media metadata ID order")
    require("result" in replies[0] and replies[1]["result"]["isError"],
            "media metadata must reach existing Core/DNS gates")
    require(all(r["error"]["code"] == -32602 for r in replies[2:]),
            "media metadata cannot authorize or bypass whitelist")


def check_image_mcp(binary):
    config = json.dumps(CONFIG).encode()
    for data in (b"", config, b"{}\n", config + b"{}\n", b"x" * 8194 + b"\n",
                 json.dumps({**CONFIG, "extra": True}).encode() + b"\n"):
        result = subprocess.run([str(binary), "mcp-images"], input=data,
                                capture_output=True, timeout=8)
        require(result.returncode == 1 and result.stdout == b"", "image MCP invalid prelude")
        require(SYNTHETIC_KEY.encode() not in result.stderr, "image MCP prelude reflection")
    check_media_metadata(binary, [str(binary), "mcp-images"], "image", config + bytes([10]))
    messages = [
        {"jsonrpc": "2.0", "id": 9007199254740993, "method": "initialize"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "image_generate", "arguments": {"confirmed": False, "request": {}}}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "image_generate", "arguments": {"confirmed": True, "request": {"model": "momoapi-gpt-image-2-5-flare", "prompt": "synthetic"}}}},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "image_task", "arguments": {"task_id": "foreign"}}},
        # Normal binary publicDial rejects localhost before connection, no public call.
        {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "image_capabilities", "arguments": {}}},
    ]
    data = config + b"\n" + ("\n".join(json.dumps(m) for m in messages) + "\n").encode()
    result = subprocess.run([str(binary), "mcp-images"], input=data, capture_output=True, timeout=8)
    require(result.returncode == 0 and result.stderr == b"", "image MCP EOF shutdown")
    require(SYNTHETIC_KEY.encode() not in result.stdout and b'"api_key"' not in result.stdout
            and b'"base_url"' not in result.stdout, "image MCP credential handoff")
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    require([r["id"] for r in replies] == [m["id"] for m in messages], "image MCP buffered input/ID precision")
    require([t["name"] for t in replies[1]["result"]["tools"]] ==
            ["gateway_capabilities", "image_capabilities", "image_generate", "image_task", "image_edit"], "image MCP whitelist")
    require(replies[2]["error"]["code"] == -32602 and
            all(r["result"]["isError"] for r in replies[3:]), "image MCP confirmation/catalog/task/DNS gates")


def check_image_mcp_idle_signal(binary, blocked_output=False, connection=None, video=False):
    options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
               else {"start_new_session": True})
    if os.name == "nt":
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = 0
        options["startupinfo"] = startup
    command = [str(binary), "mcp-videos" if video else "mcp-images"]
    if connection:
        endpoint, token = connection
        command = [str(binary), "mcp-videos-connect" if video else "mcp-images-connect", "--endpoint", endpoint]
        options["env"] = {**os.environ, "MOMO_LOCAL_API_KEY": token}
    process = subprocess.Popen(command, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options)
    try:
        prelude = b"" if connection else json.dumps(CONFIG).encode() + b"\n"
        process.stdin.write(prelude + b'{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
        process.stdin.flush()
        reply = queue.Queue(maxsize=1)
        reader = threading.Thread(target=lambda: reply.put(process.stdout.readline()), daemon=True)
        reader.start()
        require(json.loads(reply.get(timeout=8))["id"] == 1, "image MCP idle readiness")
        if blocked_output:
            # A reply much larger than a pipe's buffer; don't read it. Signal
            # must interrupt inherited stdout writes as well as stdin reads.
            message = {"jsonrpc": "2.0", "id": "x" * (128 << 10), "method": "ping"}
            process.stdin.write(json.dumps(message).encode() + b"\n")
            process.stdin.flush()
            time.sleep(0.05)  # let the fixed-size reply fill the pipe before SIGTERM
        process.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGTERM)
        require(process.wait(timeout=8) == 0, "image MCP idle signal shutdown")
        reader.join(timeout=1)
        remaining = process.stdout.read()
        require((blocked_output or remaining == b"") and process.stderr.read() == b"", "image MCP signal output")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=8)
        for pipe in (process.stdin, process.stdout, process.stderr):
            pipe.close()


def check_connected_image_mcp(binary, session):
    endpoint = "http://127.0.0.1:" + str(session.port)
    messages = [
        {"jsonrpc": "2.0", "id": 9007199254740993, "method": "initialize"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "image_capabilities", "arguments": {}}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "image_generate", "arguments": {"confirmed": True, "request": {"model": "momoapi-gpt-image-2-5-flare", "prompt": "synthetic"}}}},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "image_task", "arguments": {"task_id": "foreign"}}},
    ]
    data = ("\n".join(json.dumps(m) for m in messages) + "\n").encode()
    command = [str(binary), "mcp-images-connect", "--endpoint", endpoint]
    env = {**os.environ, "MOMO_LOCAL_API_KEY": session.token}
    check_media_metadata(binary, command, "image", env=env)
    result = subprocess.run(command, input=data, env=env, capture_output=True, timeout=8)
    require(result.returncode == 0 and result.stderr == b"", "connected MCP startup/EOF")
    require(session.token.encode() not in result.stdout and SYNTHETIC_KEY.encode() not in result.stdout,
            "connected MCP secret reflection")
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    require([r["id"] for r in replies] == [m["id"] for m in messages], "connected MCP ID order")
    require(all(r["result"]["isError"] for r in replies[2:]), "connected MCP real Core catalog/task/DNS gates")
    for key in ("", SYNTHETIC_KEY):
        result = subprocess.run(command, input=data, env={**env, "MOMO_LOCAL_API_KEY": key},
                                capture_output=True, timeout=8)
        require(result.returncode == 1 and result.stdout == b"", "connected MCP missing/invalid key")
        require(not key or key.encode() not in result.stderr, "connected MCP key error reflection")
    result = subprocess.run(command, input=data, env={**env, "MOMO_LOCAL_API_KEY": "0" * 64},
                            capture_output=True, timeout=8)
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    require(result.returncode == 0 and all(r["result"]["isError"] for r in replies[2:]), "connected MCP wrong session key")
    for url in ("http://localhost:1", "https://127.0.0.1:1", endpoint + "/", "http://example.com:1"):
        result = subprocess.run([str(binary), "mcp-images-connect", "--endpoint", url], input=data,
                                env=env, capture_output=True, timeout=8)
        require(result.returncode == 1 and result.stdout == b"", "connected MCP remote/invalid endpoint")
    check_image_mcp_idle_signal(binary, connection=(endpoint, session.token))
    check_image_mcp_idle_signal(binary, blocked_output=True, connection=(endpoint, session.token))
    session.request("GET", "/v1/models", 401, authenticated=False)  # connector never stops gateway


def check_video_mcp(binary):
    config = json.dumps(CONFIG).encode()
    check_media_metadata(binary, [str(binary), "mcp-videos"], "video", config + bytes([10]))
    for data in (b"", config, b"{}\n", config + b"{}\n", b"x" * 8194 + b"\n",
                 json.dumps({**CONFIG, "extra": True}).encode() + b"\n"):
        result = subprocess.run([str(binary), "mcp-videos"], input=data,
                                capture_output=True, timeout=8)
        require(result.returncode == 1 and result.stdout == b"", "video MCP invalid prelude")
        require(SYNTHETIC_KEY.encode() not in result.stderr, "video MCP prelude reflection")
    messages = [
        {"jsonrpc": "2.0", "id": 9007199254740993, "method": "initialize"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "video_generate", "arguments": {"confirmed": False, "request": {}}}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "video_generate", "arguments": {"confirmed": True, "request": {"model": "seedance-2.5", "prompt": "synthetic"}}}},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "video_task", "arguments": {"task_id": "foreign"}}},
        # Normal binary publicDial rejects localhost before connection, no public call.
        {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "video_capabilities", "arguments": {}}},
    ]
    data = config + b"\n" + ("\n".join(json.dumps(m) for m in messages) + "\n").encode()
    result = subprocess.run([str(binary), "mcp-videos"], input=data, capture_output=True, timeout=8)
    require(result.returncode == 0 and result.stderr == b"", "video MCP EOF shutdown")
    require(SYNTHETIC_KEY.encode() not in result.stdout and b'"api_key"' not in result.stdout
            and b'"base_url"' not in result.stdout, "video MCP credential handoff")
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    require([r["id"] for r in replies] == [m["id"] for m in messages], "video MCP buffered input/ID precision")
    require([t["name"] for t in replies[1]["result"]["tools"]] ==
            ["gateway_capabilities", "video_capabilities", "video_generate", "video_task"], "video MCP whitelist")
    require(replies[2]["error"]["code"] == -32602 and
            all(r["result"]["isError"] for r in replies[3:]), "video MCP confirmation/catalog/task/DNS gates")


def check_connected_video_mcp(binary, session):
    endpoint = "http://127.0.0.1:" + str(session.port)
    messages = [
        {"jsonrpc": "2.0", "id": 9007199254740993, "method": "initialize"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "video_capabilities", "arguments": {}}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "video_generate", "arguments": {"confirmed": True, "request": {"model": "seedance-2.5", "prompt": "synthetic"}}}},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "video_task", "arguments": {"task_id": "foreign"}}},
    ]
    data = ("\n".join(json.dumps(m) for m in messages) + "\n").encode()
    command = [str(binary), "mcp-videos-connect", "--endpoint", endpoint]
    env = {**os.environ, "MOMO_LOCAL_API_KEY": session.token}
    check_media_metadata(binary, command, "video", env=env)
    result = subprocess.run(command, input=data, env=env, capture_output=True, timeout=8)
    require(result.returncode == 0 and result.stderr == b"", "connected MCP startup/EOF")
    require(session.token.encode() not in result.stdout and SYNTHETIC_KEY.encode() not in result.stdout,
            "connected MCP secret reflection")
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    require([r["id"] for r in replies] == [m["id"] for m in messages], "connected MCP ID order")
    require(all(r["result"]["isError"] for r in replies[2:]), "connected MCP real Core catalog/task/DNS gates")
    for key in ("", SYNTHETIC_KEY):
        result = subprocess.run(command, input=data, env={**env, "MOMO_LOCAL_API_KEY": key},
                                capture_output=True, timeout=8)
        require(result.returncode == 1 and result.stdout == b"", "connected MCP missing/invalid key")
        require(not key or key.encode() not in result.stderr, "connected MCP key error reflection")
    result = subprocess.run(command, input=data, env={**env, "MOMO_LOCAL_API_KEY": "0" * 64},
                            capture_output=True, timeout=8)
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    require(result.returncode == 0 and all(r["result"]["isError"] for r in replies[2:]), "connected MCP wrong session key")
    for url in ("http://localhost:1", "https://127.0.0.1:1", endpoint + "/", "http://example.com:1"):
        result = subprocess.run([str(binary), "mcp-videos-connect", "--endpoint", url], input=data,
                                env=env, capture_output=True, timeout=8)
        require(result.returncode == 1 and result.stdout == b"", "connected MCP remote/invalid endpoint")
    check_image_mcp_idle_signal(binary, video=True, connection=(endpoint, session.token))
    check_image_mcp_idle_signal(binary, video=True, blocked_output=True, connection=(endpoint, session.token))
    session.request("GET", "/v1/models", 401, authenticated=False)  # connector never stops gateway


def check_plugin_mcp(binary, session):
    endpoint = "http://127.0.0.1:" + str(session.port)
    env = {**os.environ, "MOMO_LOCAL_API_KEY": session.token}
    for modality in ("image", "video"):
        command = [str(binary), "mcp", modality, "--endpoint", endpoint]
        export = subprocess.run([str(binary), "plugin-mcp-config", modality, "--endpoint", endpoint],
                                input=SYNTHETIC_KEY.encode(), env=env, capture_output=True, timeout=8)
        require(export.returncode == 0 and export.stderr == b"", "plugin config export")
        require(session.token.encode() not in export.stdout and SYNTHETIC_KEY.encode() not in export.stdout,
                "plugin export exposed input/env")
        config = json.loads(export.stdout)["mcpServers"]["momo-" + modality]
        require(config["args"] == command[1:] and "env" not in config, "plugin launcher contract")
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": modality + "_capabilities", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": modality + "_generate", "arguments": {"model": "seedance-2.5" if modality == "video" else "momoapi-gpt-image-2-5-flare", "prompt": "synthetic"}}},
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": modality + "_task_status", "arguments": {"task_id": "foreign"}}},
            {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": modality + "_generate", "arguments": {"confirmed": True, "request": {}}}},
        ]
        data = ("\n".join(json.dumps(m) for m in messages) + "\n").encode()
        result = subprocess.run(command, input=data, env=env, capture_output=True, timeout=8)
        require(result.returncode == 0 and result.stderr == b"", "plugin connector startup/EOF")
        require(session.token.encode() not in result.stdout and SYNTHETIC_KEY.encode() not in result.stdout,
                "plugin secret reflection")
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        require([r["id"] for r in replies] == list(range(1, 7)), "plugin IDs")
        tools = {t["name"]: t for t in replies[1]["result"]["tools"]}
        require(modality + "_task_status" in tools and modality + "_task" not in tools,
                "plugin task names")
        properties = tools[modality + "_generate"]["inputSchema"]["properties"]
        require("prompt" in properties and "model" in properties and "request" not in properties,
                "plugin flat arguments")
        require(all(r["result"]["isError"] for r in replies[2:5]) and replies[5]["error"]["code"] == -32602,
                "plugin Core private DNS/catalog/foreign task/shape gates")
        for token in ("", SYNTHETIC_KEY):
            result = subprocess.run(command, input=data, env={**env, "MOMO_LOCAL_API_KEY": token},
                                    capture_output=True, timeout=8)
            require(result.returncode == 1 and result.stdout == b"", "plugin missing key gate")
        session.request("GET", "/v1/models", 401, authenticated=False)


def check_plugin_asset_mode(binary, session):
    endpoint = "http://127.0.0.1:" + str(session.port)
    env = {**os.environ, "MOMO_LOCAL_API_KEY": session.token}
    with tempfile.TemporaryDirectory(prefix="momo-owned-asset-cli-test-") as parent:
        directory = Path(parent) / "new-assets"
        command = [str(binary), "mcp", "image", "--endpoint", endpoint, "--asset-dir", str(directory)]
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "image_asset_list", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "image_asset_get", "arguments": {"asset_id": "img_" + "0" * 64}}},
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "image_edit", "arguments": {"model": "momoapi-gpt-image-2-5-flare", "prompt": "synthetic", "reference_images": ["asset:img_" + "0" * 64]}}},
        ]
        data = ("\n".join(json.dumps(m) for m in messages) + "\n").encode()
        # Missing inherited key must not create the chosen directory.
        failed = subprocess.run(command, input=data, env={**env, "MOMO_LOCAL_API_KEY": ""}, capture_output=True, timeout=8)
        require(failed.returncode == 1 and not directory.exists() and failed.stdout == b"", "asset key-before-disk gate")
        result = subprocess.run(command, input=data, env=env, capture_output=True, timeout=8)
        require(result.returncode == 0 and result.stderr == b"", "asset connector startup/EOF")
        require(session.token.encode() not in result.stdout and SYNTHETIC_KEY.encode() not in result.stdout, "asset secret reflection")
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        names = [t["name"] for t in replies[1]["result"]["tools"]]
        require("image_asset_get" in names and "image_asset_list" in names, "asset mode tools")
        listing = json.loads(replies[2]["result"]["content"][0]["text"])
        require(listing["assets"] == [] and listing["scope"] == "connector-session", "asset empty metadata")
        require(replies[3]["result"]["isError"] and replies[4]["result"]["isError"], "asset foreign ID gates")
        require(directory.is_dir() and not list(directory.iterdir()), "metadata created files")
        # Existing directories must never be scanned or imported on restart.
        again = subprocess.run(command, input=data, env=env, capture_output=True, timeout=8)
        require(again.returncode == 1 and again.stdout == b"", "asset existing-directory gate")
        library = Path(parent) / "new-library"
        library_command = command[:-2] + ["--asset-library", str(library)]
        missing = subprocess.run(library_command, input=data, env={**env, "MOMO_LOCAL_API_KEY": ""}, capture_output=True, timeout=8)
        require(missing.returncode == 1 and not library.exists(), "library key-before-disk gate")
        for _ in range(2):
            reopened = subprocess.run(library_command, input=data, env=env, capture_output=True, timeout=8)
            require(reopened.returncode == 0 and reopened.stderr == b"", "library explicit restart/EOF")
            replies = [json.loads(line) for line in reopened.stdout.splitlines()]
            listing = json.loads(replies[2]["result"]["content"][0]["text"])
            require(listing["scope"] == "explicit-local-library" and listing["assets"] == [], "library reopen scope")
        rejected = subprocess.run(command[:-2] + ["--asset-library", str(directory)], input=data, env=env, capture_output=True, timeout=8)
        require(rejected.returncode == 1 and rejected.stdout == b"" and not list(directory.iterdir()), "library refuses unmarked session directory")
        download_directory = Path(parent) / "download-assets"
        download_command = command[:-1] + [str(download_directory), "--download-origin", "https://images.example"]
        missing = subprocess.run(download_command, input=data, env={**env, "MOMO_LOCAL_API_KEY": ""}, capture_output=True, timeout=8)
        require(missing.returncode == 1 and not download_directory.exists(), "download key-before-disk gate")
        for origin in ("http://images.example", "https://127.0.0.1", "https://user:synthetic-only@images.example", "https://images.example/path", "https://images.example?token=synthetic-only"):
            rejected = subprocess.run(download_command[:-1] + [origin], input=data, env=env, capture_output=True, timeout=8)
            require(rejected.returncode == 1 and rejected.stdout == b"" and not download_directory.exists() and b"synthetic-only" not in rejected.stderr,
                    "download origin-before-disk/redaction gate")
        enabled = subprocess.run(download_command, input=data, env=env, capture_output=True, timeout=8)
        require(enabled.returncode == 0 and enabled.stderr == b"", "explicit download startup/EOF")
        require(download_directory.is_dir() and not list(download_directory.iterdir()), "download init/metadata network/disk isolation")
        replies = [json.loads(line) for line in enabled.stdout.splitlines()]
        description = next(t["description"] for t in replies[1]["result"]["tools"] if t["name"] == "image_generate")
        require("origin-allowed URL" in description, "download mode description")
        session.request("GET", "/v1/models", 401, authenticated=False)


class Session:
    def __init__(self, binary):
        self.process = None
        self.host = self.port = self.token = None
        options = {}
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = 0
            options["startupinfo"] = startup
        else:
            options["start_new_session"] = True
        self.process = subprocess.Popen([str(binary), "serve"], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options)
        try:
            self.process.stdin.write(json.dumps(CONFIG).encode())
            self.process.stdin.close()
            handoff = queue.Queue(maxsize=1)
            self.reader = threading.Thread(target=lambda: handoff.put(self.process.stdout.readline()), daemon=True)
            self.reader.start()
            line = handoff.get(timeout=8)
            try:
                connection = json.loads(line)
                url = urlsplit(connection["base_url"])
                self.token = connection["api_key"]
                require(url.scheme == "http" and url.hostname == "127.0.0.1" and url.path == "/v1"
                        and url.port and not url.query and not url.fragment, "bad loopback handoff")
                require(len(self.token) == 64 and all(c in "0123456789abcdef" for c in self.token),
                        "bad local token")
                require(self.token != SYNTHETIC_KEY, "upstream key used as local token")
                self.host, self.port = url.hostname, url.port
            except (ValueError, KeyError, TypeError):
                raise RuntimeError("normal binary acceptance: invalid handoff") from None
        except Exception:
            self.force_stop()
            raise

    def request(self, method, path, expected, body=b"", headers=None, authenticated=True):
        values = {"Content-Type": "application/json"}
        if authenticated:
            values["Authorization"] = "Bearer " + self.token
        values.update(headers or {})
        client = http.client.HTTPConnection(self.host, self.port, timeout=4)
        try:
            client.request(method, path, body=body, headers=values)
            response = client.getresponse()
            data = response.read(4097)
            require(response.status == expected, "HTTP boundary status mismatch")
            require(len(data) <= 4096, "unexpected boundary response size")
            require(response.getheader("Cache-Control") == "no-store", "missing no-store")
            require(response.getheader("X-Content-Type-Options") == "nosniff", "missing nosniff")
            require(response.getheader("Access-Control-Allow-Origin") is None, "CORS exposed")
            require(SYNTHETIC_KEY.encode() not in data and self.token.encode() not in data, "key reflected")
        finally:
            client.close()

    def stop(self, shutdown_signal):
        self.process.send_signal(shutdown_signal)
        require(self.process.wait(timeout=8) == 0, "shutdown did not exit cleanly")
        self.reader.join(timeout=1)
        require(self.process.stdout.read() == b"", "extra stdout after private handoff")
        require(self.process.stderr.read() == b"", "unexpected runtime stderr")
        for pipe in (self.process.stdout, self.process.stderr):
            pipe.close()
        try:
            with socket.create_connection((self.host, self.port), timeout=1):
                raise RuntimeError("normal binary acceptance: listener survived shutdown")
        except OSError:
            pass

    def stall_uploads(self):
        sockets = []
        try:
            for framing in ("Content-Length: 100", "Transfer-Encoding: chunked"):
                conn = socket.create_connection((self.host, self.port), timeout=2)
                sockets.append(conn)
                prefix = "64\r\n" if framing.startswith("Transfer-Encoding") else ""
                data = ("POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer "
                        + self.token + "\r\nContent-Type: application/json\r\n" + framing + "\r\n\r\n" + prefix + "{")
                conn.sendall(data.encode())
            # Confirm partial bodies produce no response before shutdown.
            for conn in sockets:
                conn.settimeout(0.1)
                try:
                    conn.recv(1)
                except socket.timeout:
                    continue
                raise RuntimeError("normal binary acceptance: incomplete upload was not held")
            return sockets
        except Exception:
            for conn in sockets:
                conn.close()
            raise

    def force_stop(self):
        # Emergency cleanup touches only the exact child created by this check.
        if self.process is not None:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait(timeout=5)
            for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
                if pipe is not None and not pipe.closed:
                    pipe.close()


def check_boundaries(session):
    # New video subset: no catalog means no submission, foreign IDs never query;
    # ordinary binary uses existing DNS guard, not the test-only mock injector.
    for path in ("/internal/videos/capabilities", "/internal/videos/tasks/foreign"):
        session.request("GET", path, 401, authenticated=False)
        session.request("GET", path, 403, headers={"Origin":"https://foreign.invalid"})
    session.request("GET", "/internal/videos/tasks/foreign", 404)
    session.request("GET", "/internal/videos/capabilities", 502)
    session.request("POST", "/internal/videos/generate", 409, body=b'{"model":"seedance-2.5","prompt":"hi"}')
    session.request("POST", "/internal/videos/generate", 400, body=b'{"model":"seedance-2.5","model":"other","prompt":"hi"}')
    session.request("GET", "/internal/videos/generate", 405)
    session.request("POST", "/internal/videos/capabilities", 405)
    session.request("GET", "/internal/videos/capabilities?x=1", 400)
    session.request("GET", "/v1/models", 401, authenticated=False)
    session.request("GET", "/v1/models", 401, headers={"Authorization": "Bearer wrong-synthetic-local"})
    for headers in ({"Origin": "https://foreign.invalid"}, {"Origin": "null"},
                    {"Sec-Fetch-Site": "none"}, {"Sec-Fetch-Mode": "cors"}):
        session.request("GET", "/v1/models", 403, headers=headers)
    session.request("OPTIONS", "/v1/responses", 403, headers={"Origin": "https://foreign.invalid"})
    session.request("GET", "/app/state", 404)
    session.request("POST", "/app/diagnostics", 401, authenticated=False)
    session.request("POST", "/app/diagnostics", 404)
    session.request("POST", "/app/diagnostics", 403, headers={"Origin":"http://wails.localhost"})
    session.request("POST", "/internal/attachments", 401, body=b"{}", authenticated=False)
    session.request("POST", "/internal/attachments", 403, body=b"{}", headers={"Origin": "https://foreign.invalid"})
    session.request("POST", "/internal/attachments", 400, body=b"{}")  # default passthrough mode
    session.request("GET", "/internal/attachments", 405)  # no listing
    session.request("POST", "/v1/responses", 400, body=b'{"model":"gpt-5.6-sol"}', headers={"X-MOMO-Attachments":"inline"})
    for policy in ("dsml-v1", "unknown"):
        session.request("POST", "/v1/responses", 400,
                        body=b'{"model":"gpt-5.5","input":[{"role":"user","content":"hi"}]}',
                        headers={"X-MOMO-Tool-Text": policy})  # passthrough cannot opt into text synthesis
    for policy in ("replay-v1", "unknown"):
        session.request("POST", "/v1/responses", 400,
                        body=b'{"model":"gpt-5.5","input":[{"role":"user","content":"hi"}]}',
                        headers={"X-MOMO-History": policy})  # only explicit converted model replay
    session.request("POST", "/v1/responses/compact", 400,
                    body=b'{"model":"gpt-5.5","input":[]}',headers={"X-MOMO-History":"replay-v1"})
    session.request("POST", "/v1/chat/completions", 400,
                    body=b'{"model":"gpt-5.5","messages":[{"role":"user","content":"hi"}]}',
                    headers={"X-MOMO-Tool-Text": "dsml-v1"})
    session.request("GET", "/v1/responses/compact", 405)
    session.request("POST", "/v1/responses/compact", 501,
                    body=b'{"model":"gpt-5.5","input":[{"role":"user","content":"hi"}]}')
    session.request("GET", "/v1/models?extra=1", 400)
    session.request("GET", "/v1/%6dodels", 400)
    for path in ("/models", "/responses", "/chat/completions", "/responses/compact"):
        session.request("POST", path, 401, authenticated=False)
        session.request("POST", path, 403, headers={"Origin": "https://foreign.invalid"})
    for method, path in (("POST", "/models"), ("GET", "/responses/"), ("GET", "/chat/completions"), ("GET", "/responses/compact///")):
        session.request(method, path, 405)
    session.request("GET", "/models?extra=1", 400)
    session.request("POST", "/respon%73es", 400, body=b"{}")
    session.request("POST", "/responses", 400, body=b"{}")
    session.request("POST", "/responses/compact", 501, body=b'{"model":"gpt-5.5","input":[{"role":"user","content":"hi"}]}')
    session.request("GET", "/models/", 502)
    for method, path in (("POST", "/v1/models"), ("GET", "/v1/responses"), ("GET", "/v1/chat/completions")):
        session.request(method, path, 405)
    session.request("GET", "/v1/models", 400, body=b"{}")
    for body in (b"{", b"[]", b"{}", b"null", b'{"model":null}', b'{"model":"mock","stream":null}',
                 b'{"model":"mock","stream":"true"}', b'{"model":"mock","stream":1}'):
        session.request("POST", "/v1/responses", 400, body=body)
    for body in (b'{"model":"mock"}', b'{"model":"mock","messages":[]}',
                 b'{"model":"mock","messages":{}}'):
        session.request("POST", "/v1/chat/completions", 400, body=body)
    session.request("POST", "/v1/responses", 415, body=b'{}', headers={"Content-Type": "text/plain"})
    session.request("POST", "/v1/responses", 415, body=b'{}', headers={"Content-Type": "application/json-invalid"})
    session.request("POST", "/v1/responses", 413, body=b"x" * ((1 << 20) + 1))
    # localhost resolves locally. Normal publicDial rejects it before any TCP dial.
    # Shipped DNS policy/error redaction is exercised without a public upstream.
    session.request("GET", "/v1/models", 502)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: session.request("GET", "/v1/models", 401, authenticated=False), range(120)))
    session.request("POST", "/v1/responses", 400, body=b"{}")


def check_codex_catalog(binary):
    result = subprocess.run([str(binary), 'codex-text-tools-catalog', '--model', 'gpt-5.5'],
                            input=b'not-private-config', capture_output=True, timeout=8)
    require(result.returncode == 0 and result.stderr == b'', 'client catalog export')
    catalog = json.loads(result.stdout)
    require(list(catalog) == ['models'] and len(catalog['models']) == 1, 'catalog scope')
    model = catalog['models'][0]
    require(model['slug'] == 'gpt-5.5' and model['apply_patch_tool_type'] is None
            and model['supports_search_tool'] is False and model['support_verbosity'] is False
            and model['node_repl_disabled'] is True and model['supported_reasoning_levels'] == []
            and model['default_reasoning_summary'] == 'auto', 'catalog conservative contract')
    require('context_window' not in model and 'api_key' not in model
            and 'not live model' in model['description'], 'catalog unsupported claims')
    for args in (['codex-text-tools-catalog'], ['codex-text-tools-catalog', '--model', 'gpt-5.6-sol'],
                 ['codex-text-tools-catalog', '--model', 'gpt-5.5', 'extra']):
        result = subprocess.run([str(binary), *args], input=b'', capture_output=True, timeout=8)
        require(result.returncode == 1 and result.stdout == b'', 'invalid catalog mode')


def check_diagnostics(binary):
    # Offline CLI must exit even while private stdin remains open/unwritten.
    process = subprocess.Popen([str(binary), 'diagnostics'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        require(process.wait(timeout=8) == 0, 'diagnostic CLI read blocked stdin')
        require(json.loads(process.stdout.read())['scope'] == 'offline-process'
                and process.stderr.read() == b'', 'diagnostic CLI open-stdin contract')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=8)
        process.stdin.close()
        process.stdout.close()
        process.stderr.close()
    result = subprocess.run([str(binary), 'diagnostics'], input=SYNTHETIC_KEY.encode(),
                            env={**os.environ, 'MOMO_LOCAL_API_KEY': SYNTHETIC_KEY,
                                 'MOMO_API_KEY': SYNTHETIC_KEY}, capture_output=True, timeout=8)
    require(result.returncode == 0 and result.stderr == b'', 'offline diagnostics')
    require(SYNTHETIC_KEY.encode() not in result.stdout, 'diagnostics reflected stdin/env')
    report = json.loads(result.stdout)
    require(report['schema'] == 'momo-local-diagnostics-v1' and report['scope'] == 'offline-process',
            'diagnostic schema/scope')
    require(report['gateway'] == {'configured': False, 'running': False, 'active': 0,
                                 'mode': 'passthrough', 'listener_allocated': False},
            'diagnostic CLI claimed running desktop state')
    require(report['verified_upstream'] is False and report['account_wallet'] is False
            and report['cross_device'] is False, 'diagnostic capability claims')
    require(report['limits']['request_bytes'] == 1048576 and report['limits']['response_bytes'] == 16777216
            and report['limits']['history_ttl_seconds'] == 1800, 'diagnostic limits')
    for args in (['diagnostics', 'extra'], ['diagnostics', '--endpoint', 'https://localhost']):
        result = subprocess.run([str(binary), *args], input=b'', capture_output=True, timeout=8)
        require(result.returncode == 1 and result.stdout == b'', 'diagnostic arbitrary arguments')


def check_codex_three_routes(binary):
    with tempfile.TemporaryDirectory(prefix="momo-codex-route-") as directory:
        path = Path(directory).resolve() / "config.toml"
        original = 'model_provider="openai"\nmodel="gpt-5.6-luna"\n[mcp_servers.synthetic]\ncommand="preserve"\n'
        path.write_text(original, encoding="utf-8")
        (path.parent / "auth.json").mkdir()  # Must not attempt login-file reads.
        def run(action, options, extra=(), success=True):
            result = subprocess.run([str(binary), "codex-route", action, *options, *extra],
                                    capture_output=True, timeout=8)
            require((result.returncode == 0) == success, "three-route CLI status")
            require(str(path).encode() not in result.stdout and b'command' not in result.stdout,
                    "route reflected private file")
            return json.loads(result.stdout) if success else None
        for mode, endpoint in (("direct", "https://momoapi.us"),
                               ("proxy", "http://127.0.0.1:12345"), ("native", None),
                               ("proxy", "http://127.0.0.1:12345"), ("native", None)):
            options = ["--config", str(path), "--mode", mode]
            if endpoint:
                options += ["--endpoint", endpoint]
            before = path.read_bytes()
            preview = run("preview", options)
            require(path.read_bytes() == before, "route preview modified file")
            run("apply", options, ("--confirm", "--revision", "wrong"), success=False)
            require(path.read_bytes() == before, "stale route changed file")
            run("apply", options, ("--confirm", "--revision", preview["revision"]))
            content = path.read_text(encoding="utf-8")
            require('command="preserve"' in content and 'model="gpt-5.6-luna"' in content
                    and (path.parent / "auth.json").is_dir(), "route changed unrelated settings")
        require('model_provider="openai"' in content and '[model_providers.momo-go-direct]' in content
                and '[model_providers.momo-go-proxy]' in content, "native removed history providers")
        require(len(list(path.parent.glob("config.toml.momo-*.bak"))) == 5, "private route backups")
    print("PASS normal binary Codex three-route preview/revision/confirm/backup/preservation (not live login)")


def check_runtime(binary):
    check_codex_three_routes(binary)
    binary = Path(binary).resolve(strict=True)
    check_diagnostics(binary)
    check_codex_catalog(binary)
    check_invalid_inputs(binary)
    check_readonly_mcp(binary)
    check_image_mcp(binary)
    check_video_mcp(binary)
    allocated_console = False
    sessions = []
    stalled = []
    try:
        if os.name == "nt":
            # CTRL_BREAK targets only the new child process group, never the runner.
            import ctypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.GetConsoleWindow.restype = ctypes.c_void_p
            # Headless consoles may have no HWND; process-list, not window, detects attachment.
            console_processes = (ctypes.c_ulong * 1)()
            if kernel.GetConsoleProcessList(console_processes, 1) == 0:
                require(kernel.AllocConsole() != 0, "cannot create private test console")
                allocated_console = True
                ctypes.WinDLL("user32").ShowWindow(ctypes.c_void_p(kernel.GetConsoleWindow()), 0)
        check_image_mcp_idle_signal(binary)
        check_image_mcp_idle_signal(binary, blocked_output=True)
        check_image_mcp_idle_signal(binary, video=True)
        check_image_mcp_idle_signal(binary, video=True, blocked_output=True)
        for _ in range(2):
            sessions.append(Session(binary))
        first, second = sessions
        check_connected_image_mcp(binary, first)
        check_connected_video_mcp(binary, first)
        check_plugin_mcp(binary, first)
        check_plugin_asset_mode(binary, first)
        require(first.port != second.port and first.token != second.token, "multiple instances share session")
        second.request("GET", "/v1/models", 401, headers={"Authorization": "Bearer " + first.token})
        check_boundaries(first)
        stalled.extend(first.stall_uploads())
        first.stop(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGTERM)
        second.request("GET", "/v1/models", 401, authenticated=False)
        second.stop(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
    finally:
        for conn in stalled:
            conn.close()
        for session in sessions:
            session.force_stop()
        if allocated_console:
            kernel.FreeConsole()
    print("PASS normal packaged binary: read-only MCP/Skill + opt-in image MCP private prelude/buffered input/consent/catalog/task/private-DNS/EOF/idle and blocked-output signals + connected MCP separate process/exact endpoint/local key/auth/Core gates/EOF/signals/gateway remains live + owned and connected video MCP whitelist/confirmation/Core gates/EOF/idle and blocked-output signals/gateway survival + explicit flat plugin image/video connector/task_status/config-export/local-key/catalog/private-DNS/foreign-task/shape/EOF gates + opt-in asset NEW-dir/key-before-disk/get-list/foreign-ref/EOF/no-import/owner-survival gates + video API auth/browser/catalog/foreign-ID/private-DNS/method/duplicate-JSON gates + invalid config/auth/browser/body/route/private-DNS/120 requests/two instances/stalled uploads/clean signals/closed ports")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    check_runtime(parser.parse_args().binary)
