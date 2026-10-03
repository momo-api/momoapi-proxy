import assert from "node:assert/strict";
import test from "node:test";
import { Readable, PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptApiKey, readApiKeyStdin } from "../src/key-input.mjs";

test("stdin is bounded and hidden prompting refuses non-TTY", async () => {
  assert.equal(await readApiKeyStdin(Readable.from([" test-input \n"])), "test-input");
  await assert.rejects(readApiKeyStdin(Readable.from(["x".repeat(5000)])), /exceeds/);
  await assert.rejects(promptApiKey({ input: Readable.from([]), output: new PassThrough() }), /No terminal/);
});

for (const [name, text] of [["blank", "\n"], ["Ctrl-C", "\x03"], ["EOF", null], ["value", "test-hidden-candidate\n"]]) {
  test(`hidden terminal prompt handles ${name} without echo or hanging`, async () => {
    const input = new PassThrough(), output = new PassThrough();
    input.isTTY = true;
    let displayed = "";
    output.on("data", (chunk) => { displayed += chunk; });
    const result = promptApiKey({ input, output });
    if (text === null) input.end(); else input.write(text);
    assert.equal(await result, name === "value" ? "test-hidden-candidate" : "");
    assert.doesNotMatch(displayed, /test-hidden-candidate/);
    input.destroy(); output.destroy();
  });
}

test("ordinary commands do not prompt and explicit install never silently adopts saved or env Key", (t) => {
  const home = mkdtempSync(join(tmpdir(), "momo-key-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, "settings.json");
  writeFileSync(file, JSON.stringify({ apiKey: "saved-test", localToken: "local-test", port: 19998 }));
  const before = readFileSync(file, "utf8");
  const run = (args, input) => spawnSync(process.execPath, ["bin/momoapi-proxy.mjs", ...args], {
    encoding: "utf8", timeout: 5000, input, env: { ...process.env, MOMO_PROXY_HOME: home, MOMO_API_KEY: "inherited-test", MOMO_PROXY_CONSOLE_MIRROR: "0" },
  });
  const install = run(["install"]);
  assert.equal(install.status, 1);
  assert.match(install.stderr, /No terminal/);
  assert.doesNotMatch(install.stderr + install.stdout, /saved-test|inherited-test/);
  const cancel = run(["install", "--api-key-stdin"], "\n");
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /cancelled/);
  assert.equal(readFileSync(file, "utf8"), before);
  const version = run(["version"]);
  assert.equal(version.status, 0);
  assert.doesNotMatch(version.stdout + version.stderr, /Enter a new/);
  const argv = run(["key", "change", "--api-key", "do-not-echo-test"]);
  assert.equal(argv.status, 1);
  assert.doesNotMatch(argv.stdout + argv.stderr, /do-not-echo-test/);
  assert.equal(existsSync(file), true);
  const unsafeEndpoint = run(["install", "--api-key-stdin", "--endpoint", "https://foreign.invalid"], "candidate-test-input\n");
  assert.equal(unsafeEndpoint.status, 1);
  assert.ok(unsafeEndpoint.stderr.includes("restricted to https://momoapi.us"));
  assert.doesNotMatch(unsafeEndpoint.stderr + unsafeEndpoint.stdout, /candidate-test-input/);
  assert.equal(readFileSync(file, "utf8"), before);
});
