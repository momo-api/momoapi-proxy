// Real loopback mock HTTP + separate Go/Node processes; no production profiles.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '../..');
const baseline = 'e78d70fb3445eaea04ca1998bb07a35d8a3f3f30';
assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--container');
const containerMode = process.argv[2] === '--container';
if (containerMode) assert.equal(process.platform, 'linux', 'Network namespace/cgroup gate is Linux-only');
const temporary = mkdtempSync(join(tmpdir(), 'momo-go-chat-stream-'));
const oracle = join(temporary, 'oracle'), source = join(oracle, 'src');
mkdirSync(source, { recursive: true });
const files = execFileSync('git', ['ls-tree', '-r', '--name-only', baseline, 'src'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(file => file.endsWith('.mjs'));
for (const file of [...files, 'package.json']) {
  writeFileSync(join(oracle, file), execFileSync('git', ['show', baseline + ':' + file], { cwd: root, maxBuffer: 4 << 20 }));
}
const binary = join(temporary, process.platform === 'win32' ? 'mockchat.exe' : 'mockchat');
const imageTag = 'momo-go-chat-test:' + randomBytes(12).toString('hex');
let imageID;
if (containerMode) {
  const context = join(temporary, 'container-context');
  mkdirSync(join(context, 'module/cmd/mockchat'), { recursive: true });
  for (const file of ['go.mod', 'protocol.go', 'chat_stream.go', 'mock_client.go', 'cmd/mockchat/main.go']) copyFileSync(join(here, file), join(context, 'module', file));
  cpSync(oracle, join(context, 'oracle'), { recursive: true });
  for (const file of ['Containerfile.mock', 'node-mockchat.mjs', 'container-mock.mjs']) copyFileSync(join(here, file), join(context, file));
  // Normalize shell line endings even when checkout uses core.autocrlf.
  writeFileSync(join(context, 'container-entry.sh'), readFileSync(join(here, 'container-entry.sh'), 'utf8').replaceAll('\r\n', '\n'));
  execFileSync('docker', ['build', '-f', join(context, 'Containerfile.mock'), '-t', imageTag, context], { timeout: 600000, maxBuffer: 4 << 20 });
  imageID = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', imageTag], { encoding: 'utf8', timeout: 10000 }).trim();
  assert.match(imageID, /^sha256:[0-9a-f]{64}$/);
} else execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/mockchat'], { cwd: here, timeout: 120000 });
const isolatedEnv = { HOME: temporary, USERPROFILE: temporary, APPDATA: join(temporary, 'appdata'), LOCALAPPDATA: join(temporary, 'localappdata'), CODEX_HOME: join(temporary, 'codex'), MOMO_PROXY_HOME: join(temporary, 'profile'), MOMO_BRIDGE_HOME: join(temporary, 'profile'), MOMO_SWITCH_HOME: join(temporary, 'profile'), MOMO_PROXY_CONSOLE_MIRROR: '0' };
for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT']) if (process.env[key]) isolatedEnv[key] = process.env[key];
for (const key of ['APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'MOMO_PROXY_HOME']) mkdirSync(isolatedEnv[key], { recursive: true });
const capability = randomBytes(32).toString('hex');

function normalize(text) {
  assert.ok(text.endsWith('\n\n'));
  const events = text.slice(0, -2).split('\n\n').map(block => {
    const lines = block.split('\n'); assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith('event: ')); assert.ok(lines[1].startsWith('data: '));
    const event = JSON.parse(lines[1].slice(6)); assert.equal(lines[0].slice(7), event.type); return event;
  });
  assert.equal(events[0].type, 'response.created');
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.filter(e => e.type === 'response.created').length, 1);
  assert.equal(events.filter(e => e.type === 'response.completed').length, 1);
  const responseID = events[0].response.id, ids = new Map();
  for (const event of events) {
    if (event.response_id) { assert.equal(event.response_id, responseID); event.response_id = 'resp_test'; }
    if (event.response) { assert.equal(event.response.id, responseID); event.response.id = 'resp_test'; }
    if (event.type === 'response.output_item.added') { assert.equal(ids.has(event.item.id), false); ids.set(event.item.id, 'item_' + event.output_index); }
    if (event.item_id) { assert.ok(ids.has(event.item_id)); event.item_id = ids.get(event.item_id); }
    if (event.item) { assert.ok(ids.has(event.item.id)); event.item.id = ids.get(event.item.id); }
    if (event.type === 'response.completed') {
      assert.equal(event.response.output.length, ids.size);
      for (const item of event.response.output) { assert.ok(ids.has(item.id)); item.id = ids.get(item.id); }
    }
  }
  return events;
}
let mockContainerID;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 1 << 20 });
function inspect(id) { return JSON.parse(docker(['inspect', id]))[0]; }
function createContainer(kind, network) {
  const id = docker(['create', '-i', '--network=' + network, '--cpus=1', '--memory=256m', '--memory-swap=256m', '--pids-limit=64', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534', '--tmpfs=/tmp:rw,noexec,nosuid,size=32m', '--env=HOME=/tmp', '--env=CODEX_HOME=/tmp/codex', '--env=MOMO_PROXY_HOME=/tmp/profile', '--stop-timeout=1', imageID, kind]).trim();
  assert.match(id, /^[0-9a-f]{64}$/); return id;
}
function removeContainer(id) {
  const state = inspect(id).State;
  if (state.Running) { docker(['kill', id]); docker(['wait', id]); }
  const finalState = inspect(id).State;
  docker(['rm', id]);
  const remaining = docker(['ps', '-a', '--no-trunc', '--filter=id=' + id, '--format={{.ID}}']).trim();
  assert.equal(remaining, '');
  assert.equal(finalState.OOMKilled, false);
}
function verifyConfig(config, network) {
  assert.equal(config.HostConfig.Memory, 268435456);
  assert.equal(config.HostConfig.MemorySwap, 268435456);
  assert.equal(config.HostConfig.NanoCpus, 1000000000);
  assert.equal(config.HostConfig.PidsLimit, 64);
  assert.equal(config.HostConfig.ReadonlyRootfs, true);
  assert.equal(config.HostConfig.NetworkMode, network);
  assert.deepEqual(config.HostConfig.CapDrop, ['ALL']);
  assert.ok(config.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(config.HostConfig.Tmpfs['/tmp'], 'rw,noexec,nosuid,size=32m');
  assert.equal(config.Config.User, '65534:65534');
  assert.equal(config.Image, imageID);
}
async function startMock(test) {
  const id = createContainer('mock', 'none'); mockContainerID = id;
  try {
    verifyConfig(inspect(id), 'none');
    const child = spawn('docker', ['start', '-ai', id], { env: isolatedEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', failure, closed = false;
    const close = new Promise(resolve => child.on('close', code => { closed = true; resolve(code); }));
    child.on('error', e => { failure = e; });
    child.stdin.on('error', e => { failure ??= e; });
    child.stderr.on('data', chunk => { err += chunk.toString(); if (err.length > 16384) child.kill('SIGKILL'); });
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mock startup')), 10000);
      child.stdout.on('data', chunk => {
        out += chunk.toString();
        if (out.length > 1024) { clearTimeout(timer); reject(new Error('mock stdout cap')); }
        else if (out.includes('\n')) {
          clearTimeout(timer);
          try { resolve(JSON.parse(out.trim()).endpoint); } catch (e) { reject(e); }
        }
      });
      close.then(() => { clearTimeout(timer); reject(failure ?? new Error('mock exited before startup')); });
      child.stdin.end(JSON.stringify({ test: { ...test, bytes: test.bytes.toString('base64') }, capability, expectedWires }));
    });
    assert.match(endpoint, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
    return { endpoint, async finish() {
      try { assert.equal(closed, false); assert.ifError(failure); assert.equal(err, ''); assert.equal(inspect(id).State.Running, true); }
      finally {
        removeContainer(id);
        await Promise.race([close, new Promise((_, reject) => setTimeout(() => { child.kill('SIGKILL'); reject(new Error('mock attach drain timeout')); }, 3000))]);
        mockContainerID = undefined;
      }
    } };
  } catch (e) { removeContainer(id); mockContainerID = undefined; throw e; }
}
async function childRun(kind, session) {
  let containerID;
  if (containerMode) {
    containerID = createContainer(kind, 'container:' + mockContainerID);
  }
  try {
    if (containerMode) {
      verifyConfig(inspect(containerID), 'container:' + mockContainerID);
    }
    const result = await runAttached(kind, session, containerID);
    if (containerMode) {
      const state = JSON.parse(execFileSync('docker', ['inspect', containerID], { encoding: 'utf8', timeout: 10000 }))[0].State;
      assert.equal(state.Running, false); assert.equal(state.OOMKilled, false);
      assert.equal(state.ExitCode, result.code);
    }
    return result;
  } finally {
    if (containerID) removeContainer(containerID);
  }
}
function runAttached(kind, session, containerID) {
  return new Promise((resolve, reject) => {
    const command = containerMode ? 'docker' : kind === 'go' ? binary : process.execPath;
    const args = containerMode ? ['start', '-ai', containerID] : kind === 'go' ? [] : [join(here, 'node-mockchat.mjs'), join(source, 'server.mjs')];
    const child = spawn(command, args, { env: isolatedEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let outBytes = 0, errBytes = 0, failure;
    const timer = setTimeout(() => {
      failure = new Error('outer watchdog');
      if (containerID) { try { execFileSync('docker', ['kill', containerID], { timeout: 5000, stdio: 'pipe' }); } catch {} }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, containerMode ? 10000 : 6500);
    child.on('error', error => { failure = error; });
    child.stdin.on('error', error => { failure ??= error; });
    child.stdout.on('data', chunk => { outBytes += chunk.length; if (outBytes > 5 << 20) { failure = new Error('stdout cap'); child.kill(); } else stdout.push(chunk); });
    child.stderr.on('data', chunk => { errBytes += chunk.length; if (errBytes > 16 << 10) { failure = new Error('stderr cap'); child.kill(); } else stderr.push(chunk); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure); else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(JSON.stringify(session));
  });
}

const tools = [
  { type: 'namespace', name: 'pad', tools: [{ type: 'function', name: 'read' }, { type: 'custom', name: 'write' }] },
  { type: 'namespace', name: 'board', tools: [{ type: 'function', name: 'read' }] },
];
const frame = (delta, finish_reason = null) => JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] });
const tc = (index, id, name, args) => ({ index, ...(id ? { id, type: 'function' } : {}), function: { name, arguments: args } });
const normal = [
  frame({ role: 'assistant', tool_calls: [tc(7, 'call_pad', 'pad__re', '{"query":'), tc(2, 'call_board', 'board__read', '{}')] }),
  frame({ tool_calls: [tc(7, '', 'ad', '"中文🙂"}'), tc(9, 'call_write', 'pad__write', '{"input":"text(')] }),
  frame({ tool_calls: [tc(9, '', '', '\\"中文🙂\\")"}')] }),
  frame({}, 'tool_calls'), '[DONE]',
];
function encode(payloads, newline = '\n', multiline = false) {
  return Buffer.from(payloads.map(payload => {
    if (multiline && payload.startsWith('{')) payload = payload.replace('{', '{' + newline + 'data: ');
    return ': mock' + newline + 'data: ' + payload + newline + newline;
  }).join(''));
}
const cases = [
  { label: 'interleaved-lf', bytes: encode(normal), step: 7 },
  { label: 'utf8-single-byte', bytes: encode(normal), step: 1 },
  { label: 'crlf-split', bytes: encode(normal, '\r\n'), step: 1 },
  { label: 'lone-cr', bytes: encode(normal, '\r'), step: 3 },
  { label: 'multiline-data', bytes: encode(normal, '\n', true), step: 13 },
  { label: 'empty-tool-turn', bytes: encode([frame({}, 'stop'), '[DONE]']), step: 2 },
  { label: 'missing-done', bytes: encode(normal.slice(0, -1)), step: 7, goReject: true, nodeAccept: true },
  { label: 'invalid-json-frame', bytes: encode(['not-json', ...normal]), step: 7, goReject: true, nodeAccept: true },
  { label: 'unknown-tool', bytes: encode([frame({ tool_calls: [tc(0, 'call_unknown', 'missing', '{}')] }), frame({}, 'tool_calls'), '[DONE]']), step: 7, goReject: true, nodeAccept: true },
  { label: 'event-cap', bytes: Buffer.from(':' + 'x'.repeat(256 << 10) + '\n\n'), step: 4096, goReject: true },
  { label: 'event-exact-n', bytes: Buffer.concat([Buffer.from(':' + 'x'.repeat((256 << 10) - 3) + '\n\n'), encode(normal)]), step: 4096 },
  { label: 'event-n-plus-one', bytes: Buffer.concat([Buffer.from(':' + 'x'.repeat((256 << 10) - 2) + '\n\n'), encode(normal)]), step: 4096, goReject: true },
  { label: 'frame-exact-n', bytes: Buffer.concat([Buffer.from(':\n\n'.repeat(1024 - normal.length)), encode(normal)]), step: 4096 },
  { label: 'frame-n-plus-one', bytes: Buffer.concat([Buffer.from(':\n\n'.repeat(1025 - normal.length)), encode(normal)]), step: 4096, goReject: true },
  { label: 'total-input-cap', bytes: Buffer.from((':' + 'x'.repeat(220000) + '\n\n').repeat(5)), step: 4096, goReject: true },
  { label: 'wrong-mock-capability', bytes: encode(normal), step: 7, wrongCapability: true, goReject: true },
  { label: 'http-error', bytes: Buffer.from('synthetic mock error'), step: 4096, status: 503, goReject: true },
  { label: 'stall-deadline', bytes: encode([normal[0]]), step: 4096, stall: true, goReject: true },
];

let selected, expectedWires, error;
const activeSockets = new Set();
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers['x-momo-mock-capability'], capability);
    let size = 0; const chunks = [];
    for await (const chunk of request) { size += chunk.length; assert.ok(size <= 1 << 20); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.stream, true); assert.equal(body.model, 'mock');
    assert.deepEqual(body.tools.map(tool => tool.function.name), expectedWires);
    const test = selected;
    response.writeHead(test.status ?? 200, { 'content-type': 'text/event-stream', 'x-momo-mock-capability': test.wrongCapability ? 'synthetic-mismatch' : capability });
    for (let offset = 0; offset < test.bytes.length && !response.destroyed; offset += test.step) {
      if (!response.write(test.bytes.subarray(offset, offset + test.step))) await once(response, 'drain');
      await new Promise(resolve => setImmediate(resolve));
    }
    if (!test.stall) response.end();
  } catch (e) { if (!response.destroyed) { error = e; response.destroy(); } }
});
server.on('connection', socket => { activeSockets.add(socket); socket.on('close', () => activeSockets.delete(socket)); });
if (!containerMode) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const test of cases) {
    selected = test; expectedWires = ['pad__read', 'pad__write', 'board__read']; error = undefined;
    const mock = containerMode ? await startMock(test) : null;
    const endpoint = mock?.endpoint ?? 'http://127.0.0.1:' + server.address().port;
    try {
    const session = { endpoint, capability, request: { tools } };
    const go = await childRun('go', session), node = await childRun('node', session);
    if (error) throw error;
    if (!test.goReject) {
      assert.equal(go.code, 0, test.label + ' Go'); assert.equal(node.code, 0, test.label + ' Node');
      assert.equal(go.stderr, ''); assert.equal(node.stderr, '');
      assert.deepEqual(normalize(go.stdout), normalize(node.stdout), test.label);
    } else {
      assert.equal(go.code, 2, test.label); assert.equal(go.stdout, ''); assert.equal(go.stderr.trim(), 'experimental mock stream rejected');
      if (test.nodeAccept) { assert.equal(node.code, 0, test.label); normalize(node.stdout); }
      else { assert.equal(node.code, 2, test.label); assert.equal(node.stdout, ''); assert.equal(node.stderr.trim(), 'experimental mock stream rejected'); }
    }
    console.log('PASS ' + test.label + (test.nodeAccept ? ' (intentional stricter Go rejection)' : ''));
    } finally { if (mock) await mock.finish(); }
  }
} finally {
  if (mockContainerID) removeContainer(mockContainerID);
  for (const socket of activeSockets) socket.destroy();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
console.log('PASS ' + cases.length + ' same-mock subprocess cases; common raw ingress/event/frame/output caps + 3s deadline.');
if (containerMode) console.log('PASS identical cgroup-v2 limits verified inside each runner: 1 CPU, 256 MiB memory, swap 0, 64 PIDs; immutable local image ' + imageID);
else console.log('Host subprocess mode: NOT equal OS CPU/RSS limits.');
console.log('Retained synthetic source/binary/profile: ' + temporary);
console.log('NARROW CHAT BRIDGE ONLY: not full public API, Go daemon, incremental downstream or migration acceptance.');
