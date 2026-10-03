import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const baseline = 'e78d70fb3445eaea04ca1998bb07a35d8a3f3f30';
const fixtures = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8'));
const temporary = mkdtempSync(join(tmpdir(), 'momo-go-protocol-'));
const oracle = join(temporary, 'oracle');
mkdirSync(oracle);
for (const file of ['responses-sse.mjs', 'stream-transport.mjs', 'output-budget.mjs', 'tools.mjs']) {
  writeFileSync(join(oracle, file), execFileSync('git', ['show', baseline + ':src/' + file], { cwd: root, maxBuffer: 2 << 20 }));
}
const { functionEvents, customToolEvents, completed, parseSse } = await import(pathToFileURL(join(oracle, 'responses-sse.mjs')));
const { extractFunctions, restoreToolName } = await import(pathToFileURL(join(oracle, 'tools.mjs')));
const binary = join(temporary, process.platform === 'win32' ? 'fixture.exe' : 'fixture');
execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/fixture'], { cwd: here, timeout: 120000 });

function strictSse(text) {
  assert.ok(text.endsWith('\n\n'));
  const blocks = text.slice(0, -2).split('\n\n');
  const events = blocks.map(block => {
    const lines = block.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith('event: '));
    assert.ok(lines[1].startsWith('data: '));
    const event = JSON.parse(lines[1].slice(6));
    assert.equal(lines[0].slice(7), event.type);
    return event;
  });
  assert.equal(events.filter(e => e.type === 'response.completed').length, 1);
  assert.equal(events.at(-1).type, 'response.completed');
  return events;
}

// Normalize only random item IDs, after checking all references.
function normalize(events) {
  const identities = new Map();
  let doneCount = 0;
  const result = structuredClone(events);
  for (const event of result) {
    if (event.type === 'response.output_item.added') {
      assert.equal(identities.has(event.item.id), false);
      identities.set(event.item.id, 'item_' + event.output_index);
    }
    if (event.item_id) { assert.ok(identities.has(event.item_id)); event.item_id = identities.get(event.item_id); }
    if (event.item) {
      assert.ok(identities.has(event.item.id));
      event.item.id = identities.get(event.item.id);
      if (event.type === 'response.output_item.done') doneCount++;
    }
    if (event.type === 'response.completed') {
      assert.equal(event.response.output.length, doneCount);
      for (const item of event.response.output) { assert.ok(identities.has(item.id)); item.id = identities.get(item.id); }
    }
  }
  return result;
}

for (const { label, request } of fixtures) {
  const tools = extractFunctions(request);
  const output = [];
  const frames = request.calls.flatMap((call, index) => {
    const tool = restoreToolName(call.name, tools);
    assert.ok(tool.kind, label + ': oracle tool missing');
    const converted = (tool.kind === 'custom' ? customToolEvents : functionEvents)('resp_test', index, {
      callId: call.call_id, name: tool.originalName, namespace: tool.namespace,
      input: call.text, arguments: call.text,
    });
    output.push(parseSse(converted.events.at(-1))[0].item);
    return converted.events;
  });
  frames.push(completed('resp_test', 'mock', output));
  const child = spawnSync(binary, [], { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000, maxBuffer: 5 << 20 });
  assert.ifError(child.error); assert.equal(child.status, 0, label); assert.equal(child.stderr, '', label);
  assert.deepEqual(normalize(strictSse(child.stdout)), normalize(strictSse(frames.join(''))), label);
  console.log('PASS ' + label);
}
const rejects = [
  { tools: [{ type: 'namespace', name: 'a', tools: [{ type: 'function', name: 'read' }] }, { type: 'namespace', name: 'b', tools: [{ type: 'function', name: 'read' }] }], calls: [{ name: 'read', call_id: 'call_1', text: '{}' }] },
  { tools: [{ type: 'function', name: 'a.b' }, { type: 'function', name: 'a/b' }], calls: [] },
  { tools: [{ type: 'function', name: 'read' }], calls: [{ name: 'missing', call_id: 'call_1', text: '{}' }] },
  { tools: [{ type: 'function', name: 'read' }], calls: [{ name: 'read', call_id: 'call_1', text: '{}' }, { name: 'missing', call_id: 'call_2', text: '{}' }] },
];
for (const request of rejects) {
  const child = spawnSync(binary, [], { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000, maxBuffer: 5 << 20 });
  assert.ifError(child.error); assert.equal(child.status, 2); assert.equal(child.stdout, '');
  assert.equal(child.stderr.trim(), 'experimental protocol fixture rejected');
}
const npmCli = [
  process.env.npm_execpath,
  join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  join(dirname(dirname(process.execPath)), 'lib/node_modules/npm/bin/npm-cli.js'),
].find(path => path && existsSync(path));
assert.ok(npmCli, 'npm CLI missing');
const pack = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 4 << 20 }));
assert.equal(pack[0].files.some(file => file.path.startsWith('experimental/')), false);
console.log('PASS 7 differential fixtures, 4 rejection processes, npm exclusion; baseline ' + baseline);
console.log('Retained synthetic oracle and binary: ' + temporary);
console.log('OFFLINE ONLY: no mock HTTP upstream, incremental streams, real keys, profiles, or Go proxy migration acceptance.');
