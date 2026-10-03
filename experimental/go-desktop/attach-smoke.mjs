// Windows interactive session only. All sessions are synthetic/private pipes.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
const [normal, probe] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert(normal && probe && isAbsolute(normal) && isAbsolute(probe));
const token = randomBytes(32).toString('hex');
const children = [];
function launch(binary, args, session) {
  const child = spawn(binary, args, {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  const record = {child, out: '', err: '', overflow: false, closed: false, code: null};
  children.push(record);
  record.close = new Promise(resolve => {
    child.once('error', () => { record.closed = true; resolve(null); });
    child.once('close', code => { record.closed = true; record.code = code; resolve(code); });
  });
  for (const [stream, key] of [[child.stdout, 'out'], [child.stderr, 'err']]) {
    stream.on('data', b => {
      if (record[key].length + b.length > 16384) { record.overflow = true; child.kill(); }
      else record[key] += b;
    });
  }
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(session));
  return record;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(record, test, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!test() && !record.closed && Date.now() < deadline) await delay(20);
  assert(test(), 'Missing bounded process evidence');
  safe(record);
}
function safe(record) {
  assert(!record.overflow, 'Output bound exceeded');
  assert(!record.out.includes(token) && !record.err.includes(token), 'Session leaked');
}
async function finished(record, timeout = 10000) {
  let timer;
  try {
    const code = await Promise.race([record.close, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Process exit timed out')), timeout); })]);
    safe(record);
    return code;
  } finally { clearTimeout(timer); }
}
async function cli(session, action, running) {
  const record = launch(normal, [action], session);
  assert.equal(await finished(record), 0);
  const state = JSON.parse(record.out);
  assert.equal(state.Protocol, 1);
  assert.equal(state.Experimental, true);
  assert.equal(state.ProxyImplemented, false);
  assert.equal(state.DemoRunning, running);
}
let passed = false;
try {
  const daemon = launch(normal, ['serve'], {Token: token});
  await until(daemon, () => daemon.out.includes(String.fromCharCode(10)));
  const ready = JSON.parse(daemon.out.trim());
  assert.equal(ready.Protocol, 1);
  assert.equal(ready.Experimental, true);
  const session = {Endpoint: ready.Endpoint, Token: token};
  for (const mode of ['graceful', 'hold']) {
    const first = launch(probe, [mode], session);
    await until(first, () => first.out.includes('ATTACH: hidden'));
    assert.equal(first.closed, false);
    const second = launch(probe, [mode], session);
    assert.equal(await finished(second), 23, 'Second instance must exit without a second UI');
    assert(!second.out.includes('ATTACH: created') && !second.out.includes('ATTACH: loaded'));
    await until(first, () => first.out.includes('ATTACH: reopened'));
    if (mode === 'graceful') {
      assert.equal(await finished(first), 0);
      assert(first.out.includes('ATTACH: shutdown') && first.out.includes('ATTACH: passed'));
    } else {
      await until(first, () => first.out.includes('ATTACH: holding'));
      assert.equal(first.closed, false);
      assert(first.child.kill(), 'Kill only our exact disposable GUI child');
      await finished(first);
      assert(!first.out.includes('ATTACH: shutdown') && !first.out.includes('ATTACH: passed'));
    }
    assert.equal(daemon.closed, false);
    await cli(session, 'demo-start', true);
    await cli(session, 'status', true);
    await cli(session, 'demo-stop', false);
    for (const record of [first, second]) {
      const profile = record.out.split(/\r?\n/).find(l => l.startsWith('PROFILE: '));
      if (profile) console.log(profile); // Newly-created synthetic profile retained.
    }
    console.log('PASS: ' + mode + ' attached UI, second-instance reopen/exit, independent core survives and handles commands.');
  }
  passed = true;
} catch {
	for (const record of children) {
		console.error(JSON.stringify({closed: record.closed, code: record.code, configured: record.out.includes('ATTACH: configured'), created: record.out.includes('ATTACH: created'), root: record.out.includes('ATTACH: root'), loaded: record.out.includes('ATTACH: loaded'), visible: record.out.includes('ATTACH: visible'), closeReturned: record.out.includes('ATTACH: close-returned'), hidden: record.out.includes('ATTACH: hidden'), reopened: record.out.includes('ATTACH: reopened'), holding: record.out.includes('ATTACH: holding'), shutdown: record.out.includes('ATTACH: shutdown'), passed: record.out.includes('ATTACH: passed')}));
	}
  // Do not echo arbitrary child output, session or assert actual/expected values.
  console.error('FAIL: attached native lifecycle evidence incomplete');
  process.exitCode = 1;
} finally {
  for (const record of children) if (!record.closed) record.child.kill();
  await Promise.all(children.map(r => Promise.race([r.close, delay(3000)])));
  if (children.some(r => !r.closed || r.overflow || r.out.includes(token) || r.err.includes(token))) {
    passed = false;
    process.exitCode = 1;
    console.error('FAIL: exact child cleanup or output boundary');
  }
}
if (passed) console.log('NOT human tray/titlebar clicks, normal-binary UI, OS crash, macOS/Linux acceptance or Go proxy migration.');
