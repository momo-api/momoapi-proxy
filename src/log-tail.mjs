import * as fs from "node:fs";

export const LOG_TAIL_MAX_BYTES = 1024 * 1024;
export const LOG_TAIL_MAX_LINES = 1000;
const BLOCK_BYTES = 64 * 1024;

export function logTailLineCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.max(1, Math.min(LOG_TAIL_MAX_LINES, Math.floor(number))) : 100;
}

// One descriptor, one size snapshot, reverse bounded reads and one UTF-8 decode.
// No retained descriptors, whole-file allocation, or writes. Appends after the
// size snapshot are ignored; this is not an atomic snapshot of concurrent edits.
export function readLogTail(target, lines = 100, { io = fs } = {}) {
  const count = logTailLineCount(lines);
  const result = { available: false, lines: [], bytesRead: 0, maxBytes: LOG_TAIL_MAX_BYTES,
    lineLimit: count, truncated: false, byteLimitReached: false, error: null };
  let descriptor;
  try {
    // NONBLOCK prevents an unexpected FIFO from stalling before fstat on POSIX;
    // it has no effect on regular-file reads (and is absent on some platforms).
    descriptor = io.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const stat = io.fstatSync(descriptor);
    if (!stat.isFile()) { result.error = "not_regular_file"; return result; }
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error("Invalid file size");
    let position = stat.size, completedLines = 0, segmentBytes = 0, skipCR = false;
    const blocks = [];
    while (position > 0 && result.bytesRead < LOG_TAIL_MAX_BYTES && completedLines < count) {
      const length = Math.min(BLOCK_BYTES, position, LOG_TAIL_MAX_BYTES - result.bytesRead);
      position -= length;
      const block = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const received = io.readSync(descriptor, block, filled, length - filled, position + filled);
        if (!received) { result.error = "file_changed"; return result; }
        filled += received; result.bytesRead += received;
      }
      blocks.push(block);
      // Count nonempty LF/CRLF records across blocks without repeatedly
      // concatenating/decoding the accumulated tail. Lone CR is preserved.
      for (let i = block.length - 1; i >= 0; i--) {
        const byte = block[i];
        if (byte === 10) {
          if (segmentBytes) completedLines++;
          segmentBytes = 0; skipCR = true;
        } else if (skipCR && byte === 13) { skipCR = false; }
        else { segmentBytes++; skipCR = false; }
      }
    }
    let tail = Buffer.concat(blocks.reverse(), result.bytesRead);
    if (position > 0) {
      // The first fragment can start in a UTF-8 character or inside a JSON
      // record. Discard it through LF; never present a truncated record.
      const newline = tail.indexOf(10);
      tail = newline < 0 ? tail.subarray(tail.length) : tail.subarray(newline + 1);
    }
    let decoded;
    try { decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(tail); }
    catch { result.error = "invalid_utf8"; return result; }
    const entries = decoded.split(/\r?\n/).filter(Boolean);
    result.lines = entries.slice(-count);
    result.truncated = position > 0 || entries.length > count;
    result.byteLimitReached = position > 0 && result.bytesRead === LOG_TAIL_MAX_BYTES && completedLines < count;
    result.available = true;
    return result;
  } catch (error) {
    result.error = error.code === "ENOENT" ? "not_found" : "read_failed";
    return result;
  } finally {
    if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch {} }
  }
}
