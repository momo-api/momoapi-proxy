// Pinned Node's actual Chat->Responses bridge, not a helper reimplementation.
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
const INPUT = 1 << 20, EVENT = 256 << 10, OUTPUT = 4 << 20, FRAMES = 1024;
let timer, controller;
try {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length; if (bytes > INPUT) throw new Error('input'); chunks.push(chunk);
  }
  const { endpoint, capability, request } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!/^[0-9a-f]{64}$/.test(capability)) throw new Error('capability');
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('endpoint');
  const { bridgeChatCompletionsToResponses } = await import(pathToFileURL(process.argv[2]));
  const { SseFramer } = await import(new URL('./stream-transport.mjs', pathToFileURL(process.argv[2])));
  controller = new AbortController();
  timer = setTimeout(() => controller.abort(), 3000);
  const response = new EventEmitter();
  const output = [];
  let outputBytes = 0;
  response.writeHead = status => { if (status !== 200) throw new Error('status'); };
  response.write = text => {
    const chunk = Buffer.from(text);
    outputBytes += chunk.length;
    if (chunk.length > EVENT || outputBytes > OUTPUT) throw new Error('output');
    output.push(chunk); return true;
  };
  response.end = () => { response.writableEnded = true; };
  const fetchImpl = async (url, init) => {
    if (url !== endpoint + '/v1/chat/completions') throw new Error('route');
    // No upstream key or bearer leaves even this synthetic runner.
    const upstream = await fetch(url, { ...init, headers: { 'content-type': 'application/json', 'x-momo-mock-capability': capability }, redirect: 'error' });
    if (upstream.status !== 200 || upstream.headers.get('x-momo-mock-capability') !== capability || !upstream.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('upstream');
    const framer = new SseFramer({ maxEventBytes: EVENT });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let total = 0, frames = 0, rawEventBytes = 0, rawLineBytes = 0, skipLF = false;
    // Shared raw-wire budget accounting, independent of Node canonical framing.
    function accountRaw(chunk) {
      for (const byte of chunk) {
        if (skipLF) { skipLF = false; if (byte === 10) continue; }
        if (++rawEventBytes > EVENT) throw new Error('event');
        if (byte === 10 || byte === 13) {
          if (rawLineBytes === 0) { if (++frames > FRAMES) throw new Error('frames'); rawEventBytes = 0; }
          rawLineBytes = 0; skipLF = byte === 13;
        } else rawLineBytes++;
      }
    }
    async function* bounded() {
      for await (const chunk of upstream.body) {
        total += chunk.length; if (total > INPUT) throw new Error('stream');
        accountRaw(chunk);
        [...framer.push(decoder.decode(chunk, { stream: true }))];
        yield chunk;
      }
      [...framer.push(decoder.decode())];
      [...framer.finish()];
    }
    return { ok: true, status: 200, body: bounded() };
  };
  await bridgeChatCompletionsToResponses({ headers: {} }, response,
    { endpoint, apiKey: 'synthetic-unused', outputPolicy: { maxStreamMb: 1, maxRetainedMb: 1, maxEvents: FRAMES, maxItems: 128 } },
    { ...request, model: 'mock', stream: true, input: [] }, new Map(), fetchImpl, controller.signal);
  if (!response.writableEnded) throw new Error('not ended');
  clearTimeout(timer); controller.abort();
  process.stdout.write(Buffer.concat(output));
} catch {
  clearTimeout(timer); controller?.abort();
  process.stderr.write('experimental mock stream rejected\n'); process.exitCode = 2;
}
