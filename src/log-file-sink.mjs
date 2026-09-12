import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { positiveLimit } from "./log-writer.mjs";

function failure(code, mayHaveWritten = false) {
  return Object.assign(new Error(code), { code, mayHaveWritten });
}

// Caller must own this dedicated log target and authorize replacing target.1.
// Do not point at unclassified legacy logs. Cooperating writers share this lock;
// no stale-lock stealing, PID probing, or automatic crash repair.
export class RotatingLogFile {
  constructor(target, { maxFileBytes = 8 * 1024 * 1024, maxBatchBytes = 128 * 1024,
    lockAttempts = 8, lockDelayMs = 5, io = fs } = {}) {
    if (typeof target !== "string" || !isAbsolute(target)) throw new TypeError("Absolute dedicated log target required");
    this.target = resolve(target);
    this.archive = this.target + ".1";
    this.lock = this.target + ".lock";
    this.maxFileBytes = positiveLimit(maxFileBytes, 8 * 1024 * 1024, 64 * 1024 * 1024);
    this.maxBatchBytes = positiveLimit(maxBatchBytes, 128 * 1024, this.maxFileBytes);
    this.lockAttempts = positiveLimit(lockAttempts, 8, 32);
    this.lockDelayMs = positiveLimit(lockDelayMs, 5, 100);
    this.io = io;
    this.state = { rotations: 0, lockConflicts: 0, failures: 0, lastError: null };
  }

  snapshot() { return { ...this.state }; }
  checkAbort(signal) { if (signal?.aborted) throw failure("log_write_aborted"); }

  async inspect(path) {
    try {
      const stat = await this.io.lstat(path);
      if (!stat.isFile() || stat.nlink !== 1) throw failure("log_target_not_regular");
      if (stat.size > this.maxFileBytes) throw failure("log_existing_file_oversize");
      return stat;
    } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  async acquire(signal) {
    for (let attempt = 0; attempt < this.lockAttempts; attempt++) {
      this.checkAbort(signal);
      try { return await this.io.open(this.lock, "wx", 0o600); }
      catch (error) {
        if (error?.code !== "EEXIST") throw failure("log_lock_failed");
        this.state.lockConflicts++;
        if (attempt + 1 === this.lockAttempts) throw failure("log_writer_busy");
        try { await delay(this.lockDelayMs, undefined, { signal }); }
        catch { throw failure("log_write_aborted"); }
      }
    }
  }

  async append(records, { signal } = {}) {
    let handle, lockHandle, problem, mayHaveWritten = false;
    try {
      if (!Array.isArray(records) || !records.length || records.length > 1024) throw failure("log_invalid_batch");
      let bytes = 0;
      for (const record of records) {
        if (!Buffer.isBuffer(record) || record.length < 2) throw failure("log_invalid_record");
        bytes += record.length;
        if (bytes > this.maxBatchBytes) throw failure("log_batch_oversize");
        if (record.at(-1) !== 10 || record.subarray(0, -1).includes(10) || record.includes(13)) throw failure("log_invalid_record");
      }
      this.checkAbort(signal);
      await this.io.mkdir(dirname(this.target), { recursive: true, mode: 0o700 });
      lockHandle = await this.acquire(signal);
      this.checkAbort(signal);
      const expected = await this.inspect(this.target);
      const flags = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
      handle = await this.io.open(this.target, expected ? flags : flags | constants.O_EXCL, 0o600);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))) throw failure("log_target_changed");
      if (stat.size > this.maxFileBytes) throw failure("log_existing_file_oversize");
      if (stat.size) {
        const byte = Buffer.alloc(1);
        const read = await handle.read(byte, 0, 1, stat.size - 1);
        if (read.bytesRead !== 1 || byte[0] !== 10) throw failure("log_incomplete_tail");
      }
      this.checkAbort(signal);
      if (stat.size + bytes > this.maxFileBytes) {
        await handle.close(); handle = null;
        await this.inspect(this.archive);
        this.checkAbort(signal);
        // Same-directory replacement: failed rename preserves both old files.
        // No unlink-before-rename and no unbounded numbered generations.
        await this.io.rename(this.target, this.archive);
        this.state.rotations++;
        handle = await this.io.open(this.target, flags | constants.O_EXCL, 0o600);
      }
      this.checkAbort(signal);
      const buffer = Buffer.concat(records, bytes);
      let offset = 0;
      while (offset < buffer.length) {
        this.checkAbort(signal);
        mayHaveWritten = true;
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buffer.length - offset) throw failure("log_short_write", true);
        offset += bytesWritten;
      }
    } catch (error) {
      const codes = new Set(["log_write_aborted", "log_invalid_batch", "log_invalid_record", "log_batch_oversize",
        "log_lock_failed", "log_writer_busy", "log_target_not_regular", "log_target_changed",
        "log_existing_file_oversize", "log_incomplete_tail", "log_short_write"]);
      problem = failure(codes.has(error?.code) ? error.code : "log_disk_error", mayHaveWritten);
    } finally {
      if (handle) { try { await handle.close(); } catch { problem = failure("log_close_failed", mayHaveWritten); } }
      if (lockHandle) {
        try { await lockHandle.close(); await this.io.unlink(this.lock); }
        catch { problem = failure("log_unlock_failed", mayHaveWritten); }
      }
    }
    if (problem) {
      this.state.failures++; this.state.lastError = problem.code; throw problem;
    }
    this.state.lastError = null;
    // Completed append/close is not fsync or power-loss durability.
  }
}
