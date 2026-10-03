// Windows interactive-session probe only, not a release or unattended CI test.
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {isAbsolute} from 'node:path';
const binary = process.argv[2];
assert.equal(process.platform, 'win32', 'Windows native probe only');
assert(binary && isAbsolute(binary), 'Provide absolute nativecheck binary path');
const child = spawn(binary, [], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
let output = '', oversized = false;
child.stdout.on('data', b => {
  if (output.length + b.length > 16384) { oversized = true; child.kill(); }
  else output += b;
});
// Never forward arbitrary framework/WebView stderr.
child.stderr.resume();
const timer = setTimeout(() => child.kill(), 35000);
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', () => reject(Error('Native probe could not start')));
    child.once('close', resolve); // Wait until stdout/stderr pipes are drained.
  });
  const lines = output.trim().split(/\r?\n/);
  // Retain the exact newly-created synthetic profile location for review.
  // No recursive deletion or existing profile/session/credential access.
  const profile = lines.find(l => l.startsWith('PROFILE: '));
  if (profile) console.log(profile);
  const bridge = lines.filter(l => /^BRIDGE: origin=(expected|missing|other) method=(POST|other) status=[0-9]{3}$/.test(l));
  bridge.forEach(l => console.log(l));
  const report = lines.find(l => l.startsWith('{') && l.includes('"NativeCheck"'));
  assert(!oversized, 'Native probe output exceeded bound');
  assert.equal(code, 0, 'Native probe failed or watchdog killed it');
  assert(report, 'No completed native evidence report');
  const flags = JSON.parse(report);
  assert.deepEqual(flags, {FrameworkHideShow: true, NativeCheck: true, OwnedDemoStopped: true, Pass: true, PostShutdown: true, Sequence: true, TimedOut: false});
  assert.equal(bridge.length, 5);
  assert(bridge.every(l => l === 'BRIDGE: origin=expected method=POST status=200'));
  console.log('PASS: real Windows WebView Origin, demo sequence, framework Close/Hide/Show, quit and owned-demo shutdown. NOT tray clicks, independent daemon exit/crash, or macOS/Linux UI acceptance.');
} finally {
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
