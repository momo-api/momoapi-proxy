import { createHash } from "node:crypto";

const MAX_STORED_RESPONSES = 256;
const MAX_STATE_ITEMS = 2048;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_FINGERPRINT_BYTES = 8 * 1024;
const MAX_FINGERPRINT_DEPTH = 64;
const MAX_TOTAL_STATE_FINGERPRINTS = 32_768;
const MAX_IDENTITY_BYTES = 8192;

const responseStates = new Map();
let totalStateFingerprints = 0;

function inputItems(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function canonicalize(value, state, depth = 0) {
  if (depth > MAX_FINGERPRINT_DEPTH) throw new RangeError("fingerprint depth exceeded");
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    const text = JSON.stringify(value);
    state.bytes += Buffer.byteLength(text, "utf8");
    if (state.bytes > MAX_FINGERPRINT_BYTES) throw new RangeError("fingerprint size exceeded");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_FINGERPRINT_BYTES) throw new RangeError("fingerprint size exceeded");
    state.bytes += Buffer.byteLength(value, "utf8") + 2;
    if (state.bytes > MAX_FINGERPRINT_BYTES) throw new RangeError("fingerprint size exceeded");
    return value;
  }
  if (Array.isArray(value)) {
    state.bytes += 2;
    if (state.bytes > MAX_FINGERPRINT_BYTES) throw new RangeError("fingerprint size exceeded");
    return value.map((item) => canonicalize(item, state, depth + 1));
  }
  if (value && typeof value === "object") {
    state.bytes += 2;
    if (state.bytes > MAX_FINGERPRINT_BYTES) throw new RangeError("fingerprint size exceeded");
    const out = {};
    for (const key of Object.keys(value).sort()) {
      state.bytes += Buffer.byteLength(key, "utf8") + 3;
      if (state.bytes > MAX_FINGERPRINT_BYTES) throw new RangeError("fingerprint size exceeded");
      const nested = value[key];
      if (nested === undefined || typeof nested === "function" || typeof nested === "symbol") continue;
      out[key] = canonicalize(nested, state, depth + 1);
    }
    return out;
  }
  throw new TypeError("unsupported fingerprint value");
}

export function replayItemFingerprint(value) {
  try {
    const state = { bytes: 0 };
    const canonical = canonicalize(value, state);
    const serialized = JSON.stringify(canonical);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MAX_FINGERPRINT_BYTES) return null;
    return { value: createHash("sha256").update(serialized).digest("hex"), bytes };
  } catch {
    return null;
  }
}

function providerIssuedIdentity(item) {
  return item && typeof item === "object" && typeof item.id === "string" && item.id.trim()
    ? item.id.trim()
    : null;
}

function touchState(id, state) {
  responseStates.delete(id);
  responseStates.set(id, state);
}

function deleteState(id) {
  const previous = responseStates.get(id);
  if (!previous) return false;
  totalStateFingerprints = Math.max(0, totalStateFingerprints - previous.fingerprints.length);
  return responseStates.delete(id);
}

function stateFor(id) {
  if (typeof id !== "string" || !id) return null;
  const state = responseStates.get(id);
  if (!state) return null;
  touchState(id, state);
  return state;
}

function fingerprintsFor(items) {
  const fingerprints = [];
  let bytes = 0;
  for (const item of items) {
    const fingerprint = replayItemFingerprint(item);
    if (!fingerprint) return null;
    fingerprints.push(fingerprint.value);
    bytes += fingerprint.bytes;
    if (fingerprints.length > MAX_STATE_ITEMS || bytes > MAX_STATE_BYTES) return null;
  }
  return { fingerprints, bytes };
}

function matchedCompletePrefix(state, clientInput) {
  if (!state || !Number.isSafeInteger(state.providerOutputStart) || state.providerOutputStart < 0 || state.providerOutputStart >= state.fingerprints.length) return null;
  if (!state.hasProviderOutputId || clientInput.length < state.fingerprints.length) return null;
  let skippedBytes = 0;
  for (let index = 0; index < state.fingerprints.length; index++) {
    const candidate = replayItemFingerprint(clientInput[index]);
    if (!candidate || candidate.value !== state.fingerprints[index]) return null;
    skippedBytes += candidate.bytes;
  }
  return { count: state.fingerprints.length, bytes: skippedBytes };
}

/**
 * Prepare one Responses request for safe previous_response_id continuation.
 *
 * Only a complete replay of the stored prefix may be removed, and the stored prefix
 * must cross a provider-output boundary containing a provider-issued item id. Any
 * ambiguity fails open and leaves the client input untouched.
 */
export function preparePreviousResponseReplay(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const clientInput = inputItems(body.input);
  const previousId = typeof body.previous_response_id === "string" && body.previous_response_id
    ? body.previous_response_id
    : null;
  const candidate = stateFor(previousId);
  const previous = candidate && candidate.model === body.model ? candidate : null;
  const matched = matchedCompletePrefix(previous, clientInput);
  const outgoingInput = matched ? clientInput.slice(matched.count) : clientInput;
  const presented = fingerprintsFor(clientInput);
  const outbound = fingerprintsFor(outgoingInput);

  // Store the transcript the client actually presented, even when the outbound copy was
  // reduced to its new suffix. That lets the next full-transcript replay match exactly
  // without ever forwarding the repeated prefix. A foreign/expired id is non-comparable.
  const logical = previousId && !previous ? null : presented;
  const seed = body.store === false || !logical || !outbound ? null : {
    ...logical,
    // In the client-visible transcript, this turn's provider output follows the
    // complete presented prefix. Keep that boundary even when the outbound copy
    // skipped a repeated prefix.
    providerOutputStart: logical.fingerprints.length,
    model: body.model,
  };

  return {
    payload: matched ? { ...body, input: outgoingInput } : body,
    // store:false responses are not guaranteed to remain provider-addressable, so
    // they may use a known previous id once but must not mint the next replay anchor.
    seed,
    deduplicated: Boolean(matched),
    skippedItems: matched?.count || 0,
    skippedBytes: matched?.bytes || 0,
  };
}

export function rememberResponseState(responseId, seed, outputItems) {
  if (typeof responseId !== "string" || !responseId || !seed || !Array.isArray(outputItems) || outputItems.length === 0) return false;
  if (Buffer.byteLength(responseId, "utf8") > MAX_IDENTITY_BYTES || typeof seed.model !== "string" || Buffer.byteLength(seed.model, "utf8") > MAX_IDENTITY_BYTES) return false;
  const output = fingerprintsFor(outputItems);
  if (!output) return false;
  const fingerprints = [...seed.fingerprints, ...output.fingerprints];
  const bytes = seed.bytes + output.bytes;
  if (fingerprints.length > MAX_STATE_ITEMS || bytes > MAX_STATE_BYTES) return false;

  deleteState(responseId);
  const next = {
    fingerprints,
    bytes,
    providerOutputStart: Number.isSafeInteger(seed.providerOutputStart)
      && seed.providerOutputStart >= 0
      && seed.providerOutputStart <= seed.fingerprints.length
      ? seed.providerOutputStart
      : seed.fingerprints.length,
    hasProviderOutputId: outputItems.some((item) => providerIssuedIdentity(item) !== null),
    model: seed.model,
  };
  touchState(responseId, next);
  totalStateFingerprints += next.fingerprints.length;
  while (responseStates.size > MAX_STORED_RESPONSES || totalStateFingerprints > MAX_TOTAL_STATE_FINGERPRINTS) {
    const oldest = responseStates.keys().next().value;
    if (oldest === undefined) break;
    deleteState(oldest);
  }
  return true;
}

export function resetResponseStateForTests() {
  responseStates.clear();
  totalStateFingerprints = 0;
}
