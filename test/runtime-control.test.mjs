import assert from "node:assert/strict";
import test from "node:test";
import { probeManagedRuntime, stopManagedRuntime } from "../src/runtime-control.mjs";
const settings = { port: 19876, localToken: "local-test-only", apiKey: "upstream-test-never-send" };
test("stop only sends authenticated graceful shutdown and waits for closed port", async () => {
  const calls = [];
  let closed = 0;
  assert.deepEqual(await stopManagedRuntime(settings, { delay: async () => {}, portClosed: async () => ++closed > 1,
    fetchImpl: async (url, options) => {
      calls.push(url); assert.equal(options.headers["x-local-token"], settings.localToken); assert.equal(options.redirect, "error");
      assert.ok(!JSON.stringify(options).includes(settings.apiKey)); return Response.json({ ok: true });
    },
  }), { stopped: true });
  assert.deepEqual(calls, ["http://127.0.0.1:19876/internal/metrics", "http://127.0.0.1:19876/internal/shutdown"]);
});
test("untrusted service is never shut down even if it returns health-like 200", async () => {
  let count = 0;
  await assert.rejects(stopManagedRuntime(settings, { fetchImpl: async () => { count++; return Response.json({ service: "unrelated" }); } }), (e) => e.code === "runtime_untrusted");
  assert.equal(count, 1);
});
test("refused connection is offline; ambiguous network failure is not", async () => {
  assert.deepEqual(await probeManagedRuntime(settings, { fetchImpl: async () => { throw { cause: { code: "ECONNREFUSED" } }; } }), { running: false });
  await assert.rejects(probeManagedRuntime(settings, { fetchImpl: async () => { throw { cause: { code: "ETIMEDOUT" } }; } }), (e) => e.code === "runtime_probe_ambiguous");
});
test("shutdown timeout does not imply process terminated or permit tree replacement", async () => {
  await assert.rejects(stopManagedRuntime(settings, { timeoutMs: 1, delay: async () => new Promise((r) => setTimeout(r, 5)), portClosed: async () => false,
    fetchImpl: async () => Response.json({ ok: true }),
  }), (e) => e.code === "runtime_shutdown_timeout");
});
