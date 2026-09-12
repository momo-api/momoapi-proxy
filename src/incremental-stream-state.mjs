// Callers charge their output budget before passing new data to these helpers.
export const DSML_MARKERS = Object.freeze(["<｜｜DSML｜｜", "<||DSML||", "<tool_calls>", "<invoke "]);
const MARKER_TAIL = Math.max(...DSML_MARKERS.map((marker) => marker.length)) - 1;
export class DsmlMarkerDetector {
  constructor() { this.tail = ""; this.found = false; this.examinedUnits = 0; }
  push(delta) {
    if (this.found) return true;
    const window = this.tail + delta;
    this.examinedUnits += window.length;
    this.found = DSML_MARKERS.some((marker) => window.includes(marker));
    this.tail = this.found ? "" : window.slice(-MARKER_TAIL);
    return this.found;
  }
}

// Same tolerant partial-string semantics as the legacy prefix regex + decoder:
// only an initial {"input":"... is streamed; raw/cmd/etc remain done-only.
// Invalid unicode escapes stall, incomplete ones await the next chunk, unknown
// escapes keep the escaped character, and a closing quote stops. UTF-16 units
// are preserved, including a split escaped surrogate pair.
const INPUT_PREFIX = '{"input":"';
const PREFIX_WHITESPACE = new Set([0, 1, 8, 9]);
const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
export class PartialCustomInputDecoder {
  constructor() { this.prefix = 0; this.mode = "prefix"; this.hex = ""; this.examinedUnits = 0; }
  push(delta) {
    const output = [];
    const special = /["\\]/g;
    for (let index = 0; index < delta.length; index++) {
      if (this.mode === "stopped") break;
      if (this.mode === "body") {
        // Copy a normal span as one slice, not one array entry per code unit.
        special.lastIndex = index;
        const end = special.exec(delta)?.index ?? delta.length;
        if (end > index) output.push(delta.slice(index, end));
        this.examinedUnits += end - index;
        index = end;
        if (index === delta.length) break;
      }
      this.examinedUnits++;
      const char = delta[index];
      if (this.mode === "prefix") {
        if (PREFIX_WHITESPACE.has(this.prefix) && /\s/.test(char)) continue;
        if (char !== INPUT_PREFIX[this.prefix]) { this.mode = "stopped"; break; }
        if (++this.prefix === INPUT_PREFIX.length) this.mode = "body";
      } else if (this.mode === "body") {
        if (char === '"') this.mode = "stopped";
        else if (char === "\\") this.mode = "escape";
        else output.push(char);
      } else if (this.mode === "escape") {
        if (char === "u") { this.mode = "unicode"; this.hex = ""; }
        else { output.push(ESCAPES[char] ?? char); this.mode = "body"; }
      } else {
        if (!/[0-9a-fA-F]/.test(char)) { this.mode = "stopped"; break; }
        this.hex += char;
        if (this.hex.length === 4) { output.push(String.fromCharCode(Number.parseInt(this.hex, 16))); this.mode = "body"; }
      }
    }
    return output.join("");
  }
}

// ID takes precedence over index. Merge the two matched buckets in arrival
// order without visiting pending events belonging to unrelated calls.
export class PendingToolArguments {
  constructor() { this.clear(); }
  clear() { this.byId = new Map(); this.byIndex = new Map(); this.unaddressed = []; this.size = 0; this.sequence = 0; }
  add(entry) {
    const value = { ...entry, sequence: this.sequence++ };
    this.size++;
    const map = entry.itemId !== undefined ? this.byId : this.byIndex;
    const key = entry.itemId !== undefined ? entry.itemId : entry.outputIndex;
    if (key === undefined) { this.unaddressed.push(value); return; }
    let bucket = map.get(key);
    if (!bucket) { bucket = []; map.set(key, bucket); }
    bucket.push(value);
  }
  has(itemId, outputIndex) {
    return (itemId !== undefined && this.byId.has(itemId)) || (outputIndex !== undefined && this.byIndex.has(outputIndex));
  }
  take(itemId, outputIndex) {
    const ids = itemId === undefined ? [] : this.byId.get(itemId) || [];
    const indexes = outputIndex === undefined ? [] : this.byIndex.get(outputIndex) || [];
    this.byId.delete(itemId); this.byIndex.delete(outputIndex);
    this.size -= ids.length + indexes.length;
    const result = [];
    let i = 0, j = 0;
    while (i < ids.length || j < indexes.length) {
      if (j === indexes.length || (i < ids.length && ids[i].sequence < indexes[j].sequence)) result.push(ids[i++]);
      else result.push(indexes[j++]);
    }
    return result;
  }
}
