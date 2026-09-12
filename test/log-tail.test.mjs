import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRecentLogs, readRecentLogReport } from "../src/logger.mjs";
import { readRecentDiagnostics, readRecentDiagnosticReport } from "../src/diagnostics.mjs";
import { readLogTail, logTailLineCount, LOG_TAIL_MAX_BYTES } from "../src/log-tail.mjs";

function fakeFile(bytes, { size = bytes.length, shortRead = Infinity, fail = null } = {}) {
  const state = { reads: [], closed: 0 };
  const io = {
    openSync: () => { if (fail === "open") throw new Error("PRIVATE_PATH_ERROR"); return 0; },
    fstatSync: () => { if (fail === "stat") throw new Error("PRIVATE_PATH_ERROR"); return { isFile: () => fail !== "directory", size }; },
    readSync: (_fd, buffer, offset, length, position) => {
      state.reads.push({ length, position });
      if (fail === "read") throw new Error("PRIVATE_PATH_ERROR");
      if (fail === "shrink") return 0;
      const received = Math.min(length, shortRead);
      buffer.fill(120, offset, offset + received);
      const start = size - bytes.length;
      const from = Math.max(position, start), to = Math.min(position + received, size);
      if (to > from) bytes.copy(buffer, offset + from - position, from - start, to - start);
      return received;
    },
    closeSync: (fd) => { assert.equal(fd, 0); state.closed++; },
  };
  return { io, state };
}

function readBytes(content, count = 100, options = {}) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const fake = fakeFile(buffer, options);
  return { report: readLogTail("synthetic", count, { io: fake.io }), state: fake.state };
}

test("requesting excessive recent log lines is capped at 1000", () => {
  const scratch = mkdtempSync(join(tmpdir(), "momo-tail-test-"));
  try {
    writeFileSync(join(scratch, "proxy.log"), Array.from({ length: 1005 }, (_, i) => "synthetic-" + i).join("\n") + "\n");
    const result = readRecentLogs(100000, { MOMO_PROXY_HOME: scratch });
    assert.equal(result.length, 1000);
    assert.equal(result[0], "synthetic-5");
    assert.equal(result.at(-1), "synthetic-1004");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("line count has safe finite defaults and an integer 1..1000 range", () => {
  for (const value of [undefined, null, 0, -1, NaN, Infinity, -Infinity, "bad"]) assert.equal(logTailLineCount(value), 100);
  assert.equal(logTailLineCount(.5), 1);
  assert.equal(logTailLineCount(2.9), 2);
  assert.equal(logTailLineCount("5"), 5);
  assert.equal(logTailLineCount(1e12), 1000);
});

test("LF/CRLF blanks, Unicode, lone CR and unterminated final lines retain old line semantics", () => {
  for (const text of ["", "\n\r\n\n", "中文😀\r\n\nsecond\nlast", "a\rb\n c \r\nend\r", "\ufefffirst\nsecond\n"]) {
    for (const count of [1, 2, 100]) {
      const { report, state } = readBytes(text, count);
      assert.equal(report.available, true);
      assert.deepEqual(report.lines, text.split(/\r?\n/).filter(Boolean).slice(-count));
      assert.equal(state.closed, 1);
    }
  }
});

test("random bounded files match whole-file line extraction across reverse block boundaries", () => {
  let seed = 73829;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let sample = 0; sample < 100; sample++) {
    let text = "";
    for (let i = 0; i < 1300; i++) {
      text += ["", "中文😀".repeat(5), "x".repeat(180), "a\rb", " "][random(5)];
      text += random(2) ? "\r\n" : "\n";
    }
    if (random(2)) text += "final中文";
    const count = 1 + random(1000);
    const { report } = readBytes(text, count);
    assert.equal(report.available, true);
    assert.deepEqual(report.lines, text.split(/\r?\n/).filter(Boolean).slice(-count));
  }
});

test("read is bounded for a virtual 1TiB file and ignores its old content", () => {
  const { report, state } = readBytes("\n中文😀\r\nlatest\n", 2, { size: 2 ** 40 });
  assert.equal(report.available, true);
  assert.deepEqual(report.lines, ["中文😀", "latest"]);
  assert.equal(report.bytesRead, 65536);
  assert.equal(state.reads.length, 1);
  assert.equal(state.reads[0].position, 2 ** 40 - 65536);
  assert.equal(report.truncated, true);
  assert.equal(report.byteLimitReached, false);
});

test("giant records and long blank stretches never read more than 1MiB", () => {
  for (const bytes of [Buffer.alloc(2 * LOG_TAIL_MAX_BYTES, 120), Buffer.alloc(2 * LOG_TAIL_MAX_BYTES, 10)]) {
    const { report, state } = readBytes(bytes, 10);
    assert.equal(report.available, true);
    assert.deepEqual(report.lines, []);
    assert.equal(report.byteLimitReached, true);
    assert.equal(report.bytesRead, LOG_TAIL_MAX_BYTES);
    assert.equal(state.reads.length, 16);
    assert.equal(state.closed, 1);
  }
});

test("byte cap discards a leading partial UTF-8/JSON record without corrupting later records", () => {
  const tail = '\n{"message":"中文😀"}\r\n{"last":true}\n';
  const data = Buffer.concat([Buffer.from('prefix\n{"large":"'), Buffer.from("😀".repeat(300000)), Buffer.from(tail)]);
  const { report } = readBytes(data, 1000);
  assert.equal(report.byteLimitReached, true);
  assert.deepEqual(report.lines.map(JSON.parse), [{ message: "中文😀" }, { last: true }]);
  assert.doesNotMatch(report.lines.join(""), /\ufffd/);
});

test("records spanning 64KiB and CRLF split exactly across reads are counted correctly", () => {
  const lines = ["first", "😀".repeat(20000), "\r", "", "last"];
  const text = lines.join("\r\n") + "\n".repeat(65535);
  const { report } = readBytes(text, 4);
  assert.deepEqual(report.lines, text.split(/\r?\n/).filter(Boolean).slice(-4));
});

test("partial reads are filled, descriptor zero is closed, and invalid UTF-8 is explicit", () => {
  const { report, state } = readBytes("中文😀\nlast", 2, { shortRead: 2 });
  assert.equal(report.available, true);
  assert.deepEqual(report.lines, ["中文😀", "last"]);
  assert.ok(state.reads.length > 1);
  assert.equal(state.closed, 1);
  for (const invalid of [Buffer.from([97, 10, 0xff]), Buffer.from([0xf0, 0x9f, 0x98])]) {
    const result = readBytes(invalid).report;
    assert.equal(result.available, false);
    assert.equal(result.error, "invalid_utf8");
    assert.deepEqual(result.lines, []);
  }
});

test("disk/stat errors, nonfiles and detectable truncation return bounded safe errors", () => {
  for (const [fail, expected] of [["open", "read_failed"], ["stat", "read_failed"], ["read", "read_failed"], ["directory", "not_regular_file"], ["shrink", "file_changed"]]) {
    const { report, state } = readBytes("synthetic", 1, { fail });
    assert.equal(report.error, expected);
    assert.equal(report.available, false);
    assert.deepEqual(report.lines, []);
    assert.equal(state.closed, fail === "open" ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PATH_ERROR/);
  }
  const report = readLogTail("synthetic", 1, { io: { openSync: () => { throw Object.assign(new Error("hidden"), { code: "ENOENT" }); } } });
  assert.equal(report.error, "not_found");
});

test("one descriptor and size snapshot exclude appends without reopening after rename", () => {
  const original = Buffer.from("old\nlast\n"), appended = Buffer.from("old\nlast\nnew\n");
  let opens = 0, closes = 0, readEnd = 0;
  const report = readLogTail("synthetic", 2, { io: {
    openSync: () => { opens++; return 9; },
    fstatSync: () => ({ isFile: () => true, size: original.length }),
    readSync: (_fd, buffer, offset, length, position) => {
      readEnd = Math.max(readEnd, position + length);
      return appended.copy(buffer, offset, position, position + length);
    },
    closeSync: () => { closes++; },
  } });
  assert.equal(opens, 1); assert.equal(closes, 1);
  assert.equal(readEnd, original.length);
  assert.deepEqual(report.lines, ["old", "last"]);
});

test("ordinary log and diagnostic compatibility APIs share bounded reports without changing files", () => {
  const scratch = mkdtempSync(join(tmpdir(), "momo-tail-test-"));
  const env = { MOMO_PROXY_HOME: scratch };
  try {
    for (const [name, read, report] of [["proxy.log", readRecentLogs, readRecentLogReport], ["diagnostic-events.jsonl", readRecentDiagnostics, readRecentDiagnosticReport]]) {
      const target = join(scratch, name);
      assert.deepEqual(read(5, env), []);
      assert.equal(report(5, env).error, "not_found");
      const content = Array.from({ length: 1100 }, (_, i) => JSON.stringify({ index: i, text: "中文😀" })).join("\r\n");
      writeFileSync(target, content);
      assert.deepEqual(read(2, env), report(2, env).lines);
      assert.equal(read(99999, env).length, 1000);
      assert.deepEqual(read(2, env).map(JSON.parse).map((entry) => entry.index), [1098, 1099]);
      assert.equal(readFileSync(target, "utf8"), content);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

const cli = fileURLToPath(new URL("../bin/momoapi-proxy.mjs", import.meta.url));
function runCli(command, scratch) {
  return spawnSync(process.execPath, [cli, command, "-n", "5"], {
    env: { ...process.env, MOMO_PROXY_HOME: scratch, MOMO_BRIDGE_HOME: scratch },
    encoding: "utf8", windowsHide: true, timeout: 10000,
  });
}

test("CLI log and diagnostic reads warn on byte caps and return only trailing records", () => {
  const scratch = mkdtempSync(join(tmpdir(), "momo-tail-cli-test-"));
  try {
    for (const [name, command] of [["proxy.log", "logs"], ["diagnostic-events.jsonl", "diagnostics"]]) {
      writeFileSync(join(scratch, name), "x".repeat(LOG_TAIL_MAX_BYTES + 10) + '\n{"synthetic":"中文😀"}\n');
      const result = runCli(command, scratch);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /中文😀/);
      assert.doesNotMatch(result.stdout, /xxxxx/);
      assert.match(result.stderr, /1 MiB read limit/);
      assert.ok(result.stdout.length < 1000);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("CLI empty/missing is normal but invalid UTF-8 produces an explicit nonzero result", () => {
  const scratch = mkdtempSync(join(tmpdir(), "momo-tail-cli-test-"));
  try {
    for (const [name, command] of [["proxy.log", "logs"], ["diagnostic-events.jsonl", "diagnostics"]]) {
      const missing = runCli(command, scratch);
      assert.equal(missing.status, 0);
      assert.equal(missing.stderr, "");
      writeFileSync(join(scratch, name), Buffer.from([0xff]));
      const invalid = runCli(command, scratch);
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /unavailable: invalid_utf8/);
      assert.doesNotMatch(invalid.stdout, /No log entries|No diagnostic events/);
      assert.doesNotMatch(invalid.stderr, /stack|at file:/);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("POSIX FIFO log paths fail without waiting for a writer", { skip: process.platform === "win32" }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "momo-tail-fifo-test-"));
  try {
    const created = spawnSync("mkfifo", [join(scratch, "proxy.log")], { timeout: 5000 });
    assert.equal(created.status, 0);
    const result = runCli("logs", scratch);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not_regular_file/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
