import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../src/setup.mjs';
import { listen } from '../src/server.mjs';
import { resolveSettings } from '../src/config.mjs';

const targetModel = process.argv[2] || 'deepseek-v4-pro';
const expectedWord = process.argv[3] || 'MOMO_SMOKE_PASS';
const root = mkdtempSync(join(tmpdir(), 'momo-live-'));
const env = { ...process.env, CODEX_HOME: join(root, '.codex'), NO_COLOR: '1' };
await import('node:fs/promises').then(({ mkdir }) => mkdir(env.CODEX_HOME, { recursive: true }));

console.log(`Setting up bridge in isolated container environment for ${targetModel}...`);
await setup({ apiKey: process.env.MOMO_API_KEY || 'sk-momo-demo-dummy-key-placeholder', endpoint: 'https://momoapi.us', port: 18789, autostart: false, env });
const server = await listen(resolveSettings(env));
console.log('Bridge daemon running on 127.0.0.1:18789');

console.log(`Invoking Codex CLI with model ${targetModel}...`);
const child = spawn('codex', ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-m', targetModel, `Reply with exactly: ${expectedWord}`], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
});

let out = '';
child.stdout.on('data', c => out += c);
child.stderr.on('data', c => out += c);
child.on('exit', code => {
  console.log('Codex Exit Code:', code);
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
  console.log('Last lines from Codex CLI:');
  console.log(lines.slice(-4).join('\n'));
  if (out.includes(expectedWord)) {
    console.log(`RESULT: ${targetModel} SMOKE TEST SUCCESSFUL (FOUND ${expectedWord})`);
  } else {
    console.error(`RESULT: ${targetModel} SMOKE TEST FAILED`);
    process.exitCode = 1;
  }
  server.close();
  rmSync(root, { recursive: true, force: true });
});
