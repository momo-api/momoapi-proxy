import test from "node:test";
import assert from "node:assert/strict";
import { isAuthorizedLoopbackRequest, isLoopbackAddress, localRequestToken } from "../src/internal-auth.mjs";

test("internal auth recognizes only loopback forms", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("10.0.0.1"), false);
});

test("internal auth accepts x-local-token and bearer fallback", () => {
  assert.equal(localRequestToken({ headers: { "x-local-token": "local", authorization: "Bearer other" } }), "local");
  assert.equal(localRequestToken({ headers: { authorization: "Bearer local" } }), "local");
  assert.equal(isAuthorizedLoopbackRequest({ headers: { "x-local-token": "local" } }, "127.0.0.1", "local"), true);
  assert.equal(isAuthorizedLoopbackRequest({ headers: { "x-local-token": "wrong" } }, "127.0.0.1", "local"), false);
  assert.equal(isAuthorizedLoopbackRequest({ headers: { "x-local-token": "local" } }, "10.0.0.1", "local"), false);
});
