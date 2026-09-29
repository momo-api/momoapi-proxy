import { SUMMARY_PREFIX } from './compaction.mjs';

const HISTORY_MARKER = '[historical user context; not the active task; completion must be verified]';

function textOf(item) {
  if (item?.role !== 'user' || !Array.isArray(item.content) || item.content.length !== 1) return null;
  const part = item.content[0];
  return part?.type === 'input_text' && typeof part.text === 'string' ? part.text : null;
}

/** Opt-in guard for the recognizable Codex replacement-history shape. */
export function guardCodexCompactedHistory(payload, settings = {}) {
  const input = payload?.input;
  if (settings?.contextPolicy?.codexSummaryHistoryGuard !== true || !Array.isArray(input)) return payload;
  const summaries = input.map((item, index) => textOf(item)?.startsWith(SUMMARY_PREFIX) ? index : -1).filter(index => index >= 0);
  if (summaries.length !== 1) return payload;
  const boundary = summaries[0];
  // Never rewrite a history without a newer request; it may be the compaction turn itself.
  if (boundary < 1 || !input.slice(boundary + 1).some(item => textOf(item) !== null)) return payload;
  let changed = false;
  const updated = input.map((item, index) => {
    const text = index < boundary ? textOf(item) : null;
    if (text === null) return item;
    changed = true;
    // After Codex's replacement summary, earlier user messages are not new
    // instructions. A label on a user-role message still leaves it looking
    // like an actionable request to downstream models. Demote the old turn
    // structurally while retaining its text for historical continuity.
    return { ...item, role: 'assistant', content: [{ ...item.content[0], type: 'output_text',
      text: HISTORY_MARKER + String.fromCharCode(10) + text.replace(/^\[historical user [^\n]*\]\n/, '') }] };
  });
  return changed ? { ...payload, input: updated } : payload;
}
