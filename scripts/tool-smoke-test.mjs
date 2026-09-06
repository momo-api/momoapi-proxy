 
 import { spawn } from 'node:child_process';
 import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { setup } from '../src/setup.mjs';
 import { listen } from '../src/server.mjs';
 import { resolveSettings } from '../src/config.mjs';
 
 const targetModel = process.argv[2] || 'claude-opus-4-6-thinking';
 const apiKey = process.env.MOMO_API_KEY;
 if (!apiKey) throw new Error('MOMO_API_KEY is required for the live tool smoke test.');
 const root = mkdtempSync(join(tmpdir(), 'momo-tool-test-'));
 const env = { ...process.env, CODEX_HOME: join(root, '.codex'), NO_COLOR: '1' };
 await import('node:fs/promises').then(({ mkdir }) => mkdir(env.CODEX_HOME, { recursive: true }));
 
 console.log('Testing tool execution for model ' + targetModel + '...');
 await setup({ apiKey, endpoint: 'https://momoapi.us', port: 18789, autostart: false, env });
 const server = await listen(resolveSettings(env));
 
 const child = spawn('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-m', targetModel, 'Write a file named hello.txt in the current directory with content "HELLO_MOMO_TOOL_SUCCESS", and then reply with "TOOL_FINISHED"'], {
   cwd: root,
   env,
   stdio: ['ignore', 'pipe', 'pipe']
 });
 
 let out = '';
 child.stdout.on('data', c => out += c);
 child.stderr.on('data', c => out += c);
 
 const timer = setTimeout(() => {
   console.error('Timed out waiting for Codex CLI');
   child.kill('SIGKILL');
 }, 60000);
 
 child.on('exit', code => {
   clearTimeout(timer);
   console.log('Codex Exit Code:', code);
   const filePath = join(root, 'hello.txt');
   const fileExists = existsSync(filePath);
   const fileContent = fileExists ? readFileSync(filePath, 'utf8').trim() : '';
   console.log('hello.txt created:', fileExists, 'content:', fileContent);
   console.log('CLI output snippet:', out.slice(-300));
   
   if (fileExists && fileContent.includes('HELLO_MOMO_TOOL_SUCCESS')) {
     console.log('=== REAL TOOL CALLING TEST PASSED (100%) ===');
   } else {
     console.error('=== TOOL CALLING TEST FAILED ===');
     process.exitCode = 1;
   }
   server.close();
   rmSync(root, { recursive: true, force: true });
 });
 
