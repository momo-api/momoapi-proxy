import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { RotatingLogFile } from "../src/log-file-sink.mjs";
import { BoundedLogWriter } from "../src/log-writer.mjs";

const line = (text) => Buffer.from(text + "\n");
const absent = (path) => assert.rejects(fs.stat(path), { code: "ENOENT" });
async function scratch(run) {
  const root = await fs.mkdtemp(join(tmpdir(), "momo-log-sink-test-"));
  try { await run(join(root, "synthetic.log"), root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
function wrappedHandle(handle, overrides = {}) {
  return { stat: handle.stat.bind(handle), read: handle.read.bind(handle),
    write: handle.write.bind(handle), close: handle.close.bind(handle), ...overrides };
}
const diskError = () => Object.assign(new Error("PRIVATE_DISK_PATH"), { code: "EIO" });

test("append/rotation keeps complete records, two bounded generations and private new-file modes", async () => {
  await scratch(async (target, root) => {
    const sink = new RotatingLogFile(target, { maxFileBytes: 16, maxBatchBytes: 16 });
    await sink.append([line("one"), line("two")]);
    await sink.append([line("three")]);
    assert.equal(await fs.readFile(target, "utf8"), "one\ntwo\nthree\n");
    await sink.append([line("four")]);
    assert.equal(await fs.readFile(target + ".1", "utf8"), "one\ntwo\nthree\n");
    await sink.append([line("long-record")]);
    assert.equal(await fs.readFile(target + ".1", "utf8"), "four\n");
    assert.equal(await fs.readFile(target, "utf8"), "long-record\n");
    assert.deepEqual((await fs.readdir(root)).sort(), ["synthetic.log", "synthetic.log.1"]);
    for (const path of [target, target + ".1"]) {
      const stat = await fs.stat(path);
      assert.ok(stat.size <= 16);
      if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
    }
    assert.equal(sink.snapshot().rotations, 2);
  });
});

test("short writes advance precisely without duplication and unlock after full append", async () => {
  await scratch(async (target) => {
    let calls = 0;
    const io = { ...fs, open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      return path !== target ? handle : wrappedHandle(handle, { write: async (buffer, offset, length, position) => {
        calls++; return handle.write(buffer, offset, Math.min(length, 2), position);
      } });
    } };
    const sink = new RotatingLogFile(target, { io });
    await sink.append([line("中文😀"), line("last")]);
    assert.equal(await fs.readFile(target, "utf8"), "中文😀\nlast\n");
    assert.ok(calls > 1);
    await absent(target + ".lock");
  });
});

test("partial disk failure is uncertain, never replayed, and later append rejects incomplete tails", async () => {
  await scratch(async (target) => {
    let calls = 0;
    const io = { ...fs, open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      return path !== target ? handle : wrappedHandle(handle, { write: async (buffer, offset, length, position) => {
        calls++;
        if (calls > 1) throw diskError();
        return handle.write(buffer, offset, Math.min(length, 3), position);
      } });
    } };
    const sink = new RotatingLogFile(target, { io });
    await assert.rejects(sink.append([line("complete-record")]), (error) => error.code === "log_disk_error" && error.mayHaveWritten === true && !error.message.includes("PRIVATE"));
    assert.equal(await fs.readFile(target, "utf8"), "com");
    const retry = new RotatingLogFile(target);
    await assert.rejects(retry.append([line("next")]), { code: "log_incomplete_tail", mayHaveWritten: false });
    assert.equal(await fs.readFile(target, "utf8"), "com");
    assert.equal(calls, 2);
    await absent(target + ".lock");
  });
});

test("zero-byte write fails promptly and does not trigger a write retry", async () => {
  await scratch(async (target) => {
    let attempts = 0;
    const sink = new RotatingLogFile(target, { io: { ...fs, open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      return path !== target ? handle : wrappedHandle(handle, { write: async () => { attempts++; return { bytesWritten: 0 }; } });
    } } });
    await assert.rejects(sink.append([line("record")]), { code: "log_short_write", mayHaveWritten: true });
    assert.equal(attempts, 1);
    await absent(target + ".lock");
  });
});

test("rotation rename failure preserves current and previous generation without pre-deletion", async () => {
  await scratch(async (target) => {
    await fs.writeFile(target, "current\n"); await fs.writeFile(target + ".1", "old\n");
    const sink = new RotatingLogFile(target, { maxFileBytes: 8, maxBatchBytes: 8, io: { ...fs, rename: async () => { throw diskError(); } } });
    await assert.rejects(sink.append([line("next")]), { code: "log_disk_error", mayHaveWritten: false });
    assert.equal(await fs.readFile(target, "utf8"), "current\n");
    assert.equal(await fs.readFile(target + ".1", "utf8"), "old\n");
    await absent(target + ".lock");
  });
});

test("failure creating the next generation keeps the preceding log in the archive", async () => {
  await scratch(async (target) => {
    await fs.writeFile(target, "current\n");
    let opens = 0;
    const sink = new RotatingLogFile(target, { maxFileBytes: 8, maxBatchBytes: 8, io: { ...fs, open: async (path, ...args) => {
      if (path === target && ++opens === 2) throw diskError();
      return fs.open(path, ...args);
    } } });
    await assert.rejects(sink.append([line("next")]), { code: "log_disk_error", mayHaveWritten: false });
    assert.equal(await fs.readFile(target + ".1", "utf8"), "current\n");
    await absent(target);
    await absent(target + ".lock");
    await new RotatingLogFile(target, { maxFileBytes: 8, maxBatchBytes: 8 }).append([line("later")]);
    assert.equal(await fs.readFile(target, "utf8"), "later\n");
  });
});

test("oversize legacy targets, directories and hard links fail closed without modifying them", async () => {
  await scratch(async (target, root) => {
    const sink = new RotatingLogFile(target, { maxFileBytes: 8, maxBatchBytes: 8 });
    await fs.writeFile(target, "too-large-old-record\n");
    await assert.rejects(sink.append([line("new")]), { code: "log_existing_file_oversize" });
    assert.equal(await fs.readFile(target, "utf8"), "too-large-old-record\n");
    const directory = join(root, "directory"); await fs.mkdir(directory);
    await assert.rejects(new RotatingLogFile(directory).append([line("new")]), { code: "log_target_not_regular" });
    const linked = join(root, "linked"); await fs.link(target, linked);
    await assert.rejects(new RotatingLogFile(linked).append([line("new")]), { code: "log_target_not_regular" });
    await absent(target + ".lock");
    await absent(linked + ".lock");
  });
});

test("invalid archive prevents rotation without replacing the active file", async () => {
  await scratch(async (target) => {
    await fs.writeFile(target, "current\n"); await fs.mkdir(target + ".1");
    await assert.rejects(new RotatingLogFile(target, { maxFileBytes: 8, maxBatchBytes: 8 }).append([line("new")]), { code: "log_target_not_regular" });
    assert.equal(await fs.readFile(target, "utf8"), "current\n");
    assert.equal((await fs.stat(target + ".1")).isDirectory(), true);
  });
});

test("a held/stale lock has bounded attempts and is never stolen or unlinked", async () => {
  await scratch(async (target) => {
    await fs.writeFile(target + ".lock", "synthetic owner");
    const sink = new RotatingLogFile(target, { lockAttempts: 3, lockDelayMs: 1 });
    await assert.rejects(sink.append([line("new")]), { code: "log_writer_busy", mayHaveWritten: false });
    assert.equal(sink.snapshot().lockConflicts, 3);
    assert.equal(await fs.readFile(target + ".lock", "utf8"), "synthetic owner");
    await absent(target);
  });
});

test("abort before entry and during lock contention never touches log data or another lock", async () => {
  await scratch(async (target) => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(new RotatingLogFile(target).append([line("new")], { signal: controller.signal }), { code: "log_write_aborted" });
    await absent(target); await absent(target + ".lock");
    await fs.writeFile(target + ".lock", "owner");
    const waiting = new AbortController();
    const promise = new RotatingLogFile(target, { lockAttempts: 32, lockDelayMs: 100 }).append([line("new")], { signal: waiting.signal });
    waiting.abort();
    await assert.rejects(promise, { code: "log_write_aborted" });
    assert.equal(await fs.readFile(target + ".lock", "utf8"), "owner");
    await absent(target);
  });
});

test("unlock failure is explicit and retains the lock instead of risking competing writers", async () => {
  await scratch(async (target) => {
    const sink = new RotatingLogFile(target, { io: { ...fs, unlink: async () => { throw diskError(); } } });
    await assert.rejects(sink.append([line("saved")]), { code: "log_unlock_failed", mayHaveWritten: true });
    assert.equal(await fs.readFile(target, "utf8"), "saved\n");
    assert.equal((await fs.stat(target + ".lock")).isFile(), true);
    assert.doesNotMatch(JSON.stringify(sink.snapshot()), /PRIVATE|synthetic|saved/);
  });
});

test("configuration and malformed batches fail before any filesystem call", async () => {
  assert.throws(() => new RotatingLogFile("relative.log"), TypeError);
  await scratch(async (target) => {
    for (const value of [0, NaN, Infinity, -1, 1.2]) assert.throws(() => new RotatingLogFile(target, { maxFileBytes: value }), RangeError);
    let diskCalls = 0;
    const sink = new RotatingLogFile(target, { maxFileBytes: 8, maxBatchBytes: 8, io: { mkdir: async () => { diskCalls++; } } });
    for (const value of [[], ["text"], [Buffer.from("missing-LF")], [Buffer.from("one\ntwo\n")], [Buffer.from("a\rb\n")], [line("x".repeat(9))]]) await assert.rejects(sink.append(value));
    assert.equal(diskCalls, 0);
  });
});

const sinkUrl = new URL("../src/log-file-sink.mjs", import.meta.url).href;
function writerChild(target, worker, maxFileBytes = 1048576) {
  const code = 'const {RotatingLogFile}=await import(process.argv[1]); const sink=new RotatingLogFile(process.argv[2],{maxFileBytes:Number(process.argv[4]),maxBatchBytes:64,lockAttempts:32,lockDelayMs:25}); for(let i=0;i<12;i++) await sink.append([Buffer.from(JSON.stringify({worker:Number(process.argv[3]),i,text:"中文😀"})+"\\n")]);';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, sinkUrl, target, String(worker), String(maxFileBytes)], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Synthetic writer timed out")); }, 15000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (status) => { clearTimeout(timer); status === 0 ? resolve() : reject(new Error("Synthetic writer failed: " + status)); });
  });
}

test("four real processes share a log without lost, duplicated or interleaved records", async () => {
  await scratch(async (target) => {
    await Promise.all([0, 1, 2, 3].map((worker) => writerChild(target, worker)));
    const rows = (await fs.readFile(target, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 48);
    assert.equal(new Set(rows.map(({ worker, i }) => worker + ":" + i)).size, 48);
    for (const row of rows) assert.equal(row.text, "中文😀");
    for (let worker = 0; worker < 4; worker++) assert.deepEqual(rows.filter((row) => row.worker === worker).map((row) => row.i), Array.from({ length: 12 }, (_, i) => i));
    await absent(target + ".lock");
  });
});

test("composed queue and sink settle only after disk close and support repeated bounded rotation", async () => {
  await scratch(async (target) => {
    const sink = new RotatingLogFile(target, { maxFileBytes: 64, maxBatchBytes: 32 });
    const writer = new BoundedLogWriter({ sink, maxQueueBytes: 256, maxRecordBytes: 32, maxBatchBytes: 32 });
    for (let i = 0; i < 20; i++) {
      assert.equal(writer.enqueue(JSON.stringify({ i })), true);
      assert.equal((await writer.flush()).completed, true);
    }
    assert.equal((await writer.close()).written, 20);
    const rows = [];
    for (const path of [target + ".1", target]) {
      assert.ok((await fs.stat(path)).size <= 64);
      rows.push(...(await fs.readFile(path, "utf8")).trim().split("\n").map(JSON.parse));
    }
    assert.equal(rows.at(-1).i, 19);
    assert.deepEqual(rows.map((row) => row.i), Array.from({ length: rows.length }, (_, i) => 20 - rows.length + i));
    await absent(target + ".lock");
  });
});

test("POSIX symlink targets are rejected and their referents remain unchanged", { skip: process.platform === "win32" }, async () => {
  await scratch(async (target, root) => {
    const other = join(root, "other"); await fs.writeFile(other, "original\n");
    await fs.symlink(other, target);
    await assert.rejects(new RotatingLogFile(target).append([line("new")]), { code: "log_target_not_regular" });
    assert.equal(await fs.readFile(other, "utf8"), "original\n");
  });
});

test("four-process rotation keeps only two bounded parseable generations", async () => {
  await scratch(async (target, root) => {
    await Promise.all([0, 1, 2, 3].map((worker) => writerChild(target, worker, 256)));
    const rows = [];
    for (const path of [target + ".1", target]) {
      assert.ok((await fs.stat(path)).size <= 256);
      rows.push(...(await fs.readFile(path, "utf8")).trim().split("\n").map(JSON.parse));
    }
    assert.ok(rows.length > 1 && rows.length < 48);
    assert.equal(new Set(rows.map(({ worker, i }) => worker + ":" + i)).size, rows.length);
    assert.equal(rows.at(-1).i, 11);
    assert.deepEqual((await fs.readdir(root)).sort(), ["synthetic.log", "synthetic.log.1"]);
  });
});

test("open/stat/close errors do not leak raw filesystem details and release owned locks", async () => {
  await scratch(async (target) => {
    for (const failure of ["open", "stat", "close"]) {
      const sink = new RotatingLogFile(target, { io: { ...fs, open: async (path, ...args) => {
        if (path === target && failure === "open") throw diskError();
        const handle = await fs.open(path, ...args);
        if (path !== target) return handle;
        return wrappedHandle(handle, {
          stat: async () => { if (failure === "stat") throw diskError(); return handle.stat(); },
          close: async () => { await handle.close(); if (failure === "close") throw diskError(); },
        });
      } } });
      await assert.rejects(sink.append([line("new")]), (error) => {
        assert.doesNotMatch(error.message, /PRIVATE/);
        assert.equal(error.mayHaveWritten, failure === "close");
        return true;
      });
      await absent(target + ".lock");
    }
  });
});

test("abort after a partial write stops remaining bytes and releases its lock", async () => {
  await scratch(async (target) => {
    const controller = new AbortController();
    let writes = 0;
    const sink = new RotatingLogFile(target, { io: { ...fs, open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      return path !== target ? handle : wrappedHandle(handle, { write: async (buffer, offset, length, position) => {
        writes++;
        const result = await handle.write(buffer, offset, Math.min(length, 2), position);
        controller.abort(); return result;
      } });
    } } });
    await assert.rejects(sink.append([line("new")], { signal: controller.signal }), { code: "log_write_aborted", mayHaveWritten: true });
    assert.equal(writes, 1);
    assert.equal(await fs.readFile(target, "utf8"), "ne");
    await absent(target + ".lock");
  });
});
