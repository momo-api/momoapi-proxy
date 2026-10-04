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
    session.request("GET", "/v1/models", 401, authenticated=False)
    session.request("GET", "/v1/models", 401, headers={"Authorization": "Bearer wrong-synthetic-local"})
    for headers in ({"Origin": "https://foreign.invalid"}, {"Origin": "null"},
                    {"Sec-Fetch-Site": "none"}, {"Sec-Fetch-Mode": "cors"}):
        session.request("GET", "/v1/models", 403, headers=headers)
    session.request("OPTIONS", "/v1/responses", 403, headers={"Origin": "https://foreign.invalid"})
    session.request("GET", "/app/state", 404)
    session.request("GET", "/v1/models?extra=1", 400)
    session.request("GET", "/v1/%6dodels", 400)
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


def check_runtime(binary):
    binary = Path(binary).resolve(strict=True)
    check_invalid_inputs(binary)
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
        for _ in range(2):
            sessions.append(Session(binary))
        first, second = sessions
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
    print("PASS normal packaged binary: invalid config/auth/browser/body/route/private-DNS/120 requests/two instances/stalled uploads/clean signals/closed ports")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    check_runtime(parser.parse_args().binary)
