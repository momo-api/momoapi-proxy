import assert from "node:assert/strict";
import test from "node:test";
import { upgradeMacInstallRuntime } from "../src/install-runtime.mjs";
const saved = { apiKey: "old-test-key", localToken: "test-local-token", port: 19999, autostart: true };
const options = { osPlatform: "darwin", existsSyncImpl: () => true, delay: async () => {} };

test("Mac legacy migration authenticates then activates only managed service using old settings", async () => {
  let activated = false, attempts = 0;
  assert.deepEqual(await upgradeMacInstallRuntime(saved, { ...options,
    autostartInstaller(settings, context) { assert.deepEqual(settings, saved); assert.equal(context.osPlatform, "darwin"); activated = true; },
    fetchImpl: async (url, request) => {
      assert.equal(request.headers["x-local-token"], saved.localToken); assert.equal(request.redirect, "error");
      assert.ok(!JSON.stringify(request).includes(saved.apiKey));
      if (url.endsWith("/internal/metrics")) { assert.equal(activated, false); return Response.json({ ok: true }); }
      assert.equal(activated, true);
      return ++attempts === 1 ? new Response("", { status: 404 }) : Response.json({ ok: true, apiKeyChange: true });
    },
  }), { upgraded: true });
  assert.equal(attempts, 2);
});
test("missing or disabled Mac agent and other platforms never attempt migration", async () => {
  for (const context of [{ osPlatform: "win32" }, { existsSyncImpl: () => false }, { saved: { ...saved, autostart: false } }]) {
    await assert.rejects(upgradeMacInstallRuntime(context.saved || saved, { ...options, ...context,
      fetchImpl: () => assert.fail("must not fetch"), autostartInstaller: () => assert.fail("must not activate"),
    }), /requires a managed Mac/);
  }
});
test("authentication refusal never controls service", async () => {
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(upgradeMacInstallRuntime(saved, { ...options, fetchImpl: async () => Response.json({ ok: false }, { status }),
      autostartInstaller: () => assert.fail("must not activate"),
    }), /Cannot authenticate/);
  }
});
test("readiness requires authenticated capability, not arbitrary health 200", async () => {
  let activated = false;
  await assert.rejects(upgradeMacInstallRuntime(saved, { ...options, timeoutMs: 5, delay: async () => new Promise((r) => setTimeout(r, 5)),
    autostartInstaller: () => { activated = true; },
    fetchImpl: async (url) => Response.json(url.endsWith("/internal/metrics") ? { ok: true } : { ok: true, version: "old" }),
  }), /readiness was not confirmed/);
  assert.equal(activated, true);
});
