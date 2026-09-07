import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { bodyOf, getMaxRequestBodyBytes } from "../src/server.mjs";

test("getMaxRequestBodyBytes respects env and settings", () => {
  assert.equal(getMaxRequestBodyBytes({}), 64 * 1024 * 1024);
  assert.equal(getMaxRequestBodyBytes({ maxRequestBodyMb: 10 }), 10 * 1024 * 1024);
  process.env.MOMO_MAX_REQUEST_BODY_MB = "32";
  assert.equal(getMaxRequestBodyBytes({ maxRequestBodyMb: 10 }), 32 * 1024 * 1024);
  delete process.env.MOMO_MAX_REQUEST_BODY_MB;
});

test("bodyOf successfully parses valid JSON within limit", async () => {
  const server = createServer(async (req, res) => {
    try {
      const data = await bodyOf(req, { maxRequestBodyMb: 1 });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, echo: data }));
    } catch (err) {
      res.writeHead(err.statusCode || 500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message, code: err.code }));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello world" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.echo.message, "hello world");
  } finally {
    server.close();
  }
});

test("bodyOf rejects requests exceeding size limit with HTTP 413 payload_too_large", async () => {
  const server = createServer(async (req, res) => {
    try {
      // 设置极小限制: 1MB
      const data = await bodyOf(req, { maxRequestBodyMb: 1 });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(err.statusCode || 500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message, code: err.code }));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // 构造超过 1MB 的超大 payload
    const largeString = "a".repeat(1.2 * 1024 * 1024);
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: largeString }),
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.code, "payload_too_large");
  } finally {
    server.close();
  }
});

test("bodyOf rejects invalid JSON with HTTP 400 invalid_json", async () => {
  const server = createServer(async (req, res) => {
    try {
      await bodyOf(req, { maxRequestBodyMb: 1 });
      res.writeHead(200);
      res.end();
    } catch (err) {
      res.writeHead(err.statusCode || 500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message, code: err.code }));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not a valid json {{{",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_json");
  } finally {
    server.close();
  }
});
