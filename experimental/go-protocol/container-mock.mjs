// Disposable network-none mock namespace; accepts only synthetic fixture input.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
let server;
const sockets = new Set();
try {
  let count = 0; const chunks = [];
  for await (const chunk of process.stdin) { count += chunk.length; if (count > 2 << 20) throw new Error(); chunks.push(chunk); }
  const { test, capability, expectedWires } = JSON.parse(Buffer.concat(chunks));
  const bytes = Buffer.from(test.bytes, 'base64');
  assert.match(capability, /^[0-9a-f]{64}$/);
  assert.ok(bytes.length <= 2 << 20); assert.ok(Number.isInteger(test.step) && test.step > 0);
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers['x-momo-mock-capability'], capability);
      let size = 0; const bodyChunks = [];
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 1 << 20); bodyChunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(bodyChunks));
      assert.equal(body.stream, true); assert.equal(body.model, 'mock');
      assert.deepEqual(body.tools.map(tool => tool.function.name), expectedWires);
      response.writeHead(test.status ?? 200, { 'content-type': 'text/event-stream', 'x-momo-mock-capability': test.wrongCapability ? 'synthetic-mismatch' : capability });
      for (let offset = 0; offset < bytes.length && !response.destroyed; offset += test.step) {
        if (!response.write(bytes.subarray(offset, offset + test.step))) await Promise.race([once(response, 'drain'), once(response, 'close')]);
        await new Promise(resolve => setImmediate(resolve));
      }
      if (!test.stall) response.end();
    } catch {
      process.stderr.write('synthetic mock assertion failed\n'); process.exitCode = 2;
      response.destroy(); for (const socket of sockets) socket.destroy(); server.close();
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.stdout.write(JSON.stringify({ endpoint: 'http://127.0.0.1:' + server.address().port }) + '\n');
  // Independent fail-safe if the host orchestrator disappears.
  setTimeout(() => { for (const socket of sockets) socket.destroy(); server.close(); process.exitCode = 2; }, 30000).unref();
} catch { process.stderr.write('synthetic mock rejected\n'); process.exitCode = 2; }
