import assert from "node:assert/strict";
import test from "node:test";
import { asArray, authorized, json, openCodeUpstreamHeaders, upstreamHeaders, writeSse } from "../src/http-lifecycle.mjs";

function responseStub() {
  return { headers: null, status: null, body: [], writeHead(status, headers) { this.status = status; this.headers = headers; }, write(chunk) { this.body.push(chunk); }, end(chunk) { if (chunk !== undefined) this.body.push(chunk); this.ended = true; } };
}

const settings = { host: "127.0.0.1", localToken: "local", apiKey: "remote" };

test("HTTP lifecycle helpers preserve JSON/SSE wire headers and body order", () => {
  assert.deepEqual(asArray([1, 2]), [1, 2]);
  assert.deepEqual(asArray(null), []);

  const jsonResponse = responseStub();
  json(jsonResponse, 201, { ok: true }, { "cache-control": "no-store" });
  assert.equal(jsonResponse.status, 201);
  assert.equal(jsonResponse.headers["content-type"], "application/json");
  assert.equal(jsonResponse.headers["cache-control"], "no-store");
  assert.deepEqual(jsonResponse.body, ["{\"ok\":true}"]);

  const sseResponse = responseStub();
  writeSse(sseResponse, ["data: one\n\n", "data: two\n\n"]);
  assert.equal(sseResponse.status, 200);
  assert.equal(sseResponse.headers["content-type"], "text/event-stream");
  assert.deepEqual(sseResponse.body, ["data: one\n\n", "data: two\n\n"]);
  assert.equal(sseResponse.ended, true);
});

test("authorization and upstream session headers retain existing policy", () => {
  const auth = (authorization, remoteAddress = "10.0.0.5") => authorized({ headers: authorization ? { authorization } : {}, socket: { remoteAddress } }, settings);
  assert.equal(auth("Bearer local"), true);
  assert.equal(auth("Bearer remote"), true);
  assert.equal(auth("Bearer momo-local-key"), true);
  assert.equal(auth("Bearer wrong"), false);
  assert.equal(auth(null, "127.0.0.1"), true);
  assert.equal(auth(null, "::1"), true);
  assert.equal(auth(null, "10.0.0.5"), false);

  assert.deepEqual(upstreamHeaders(settings), { authorization: "Bearer remote", "content-type": "application/json" });
  assert.deepEqual(upstreamHeaders(settings, "text/plain"), { authorization: "Bearer remote", "content-type": "text/plain" });
  const sessionHeaders = openCodeUpstreamHeaders(settings, { headers: { "x-opencode-session": "session-1" } }, { model: "gpt-5.5", input: [] }, new Map());
  assert.deepEqual(sessionHeaders, { authorization: "Bearer remote", "content-type": "application/json", "x-opencode-session": "session-1" });
});
