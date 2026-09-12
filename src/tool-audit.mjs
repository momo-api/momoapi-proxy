import { createHash } from 'node:crypto';
const hash = (value) => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);
const isCall = (item) => item?.type === 'function_call' || item?.type === 'custom_tool_call';
const isOutput = (item) => item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output';

// Structure only: no names, descriptions, schemas, arguments, outputs or raw IDs.
export function summarizeToolRequest(body = {}) {
  const leaves = [];
  const visit = (tools, depth = 0) => {
    if (!Array.isArray(tools) || depth > 8) return;
    for (const tool of tools) {
      if (tool?.type === 'namespace') visit(tool.tools, depth + 1);
      else leaves.push({ type: ['function', 'custom', 'tool_search'].includes(tool?.type) ? tool.type : 'other', nameHash: hash(tool?.name) });
    }
  };
  visit(body.tools);
  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of input) if (item?.type === 'additional_tools') visit(item.tools);
  const calls = new Set(input.filter(isCall).map((item) => item.call_id));
  const outputs = input.filter(isOutput);
  const choice = body.tool_choice;
  return { topLevelTools: Array.isArray(body.tools) ? body.tools.length : 0,
    leafTools: leaves.length, tools: leaves.slice(0, 128), truncated: leaves.length > 128,
    choice: typeof choice === 'string' && ['auto', 'none', 'required'].includes(choice) ? choice : choice == null ? 'unset' : 'selector',
    choiceHash: hash(JSON.stringify(choice)), calls: calls.size, outputs: outputs.length,
    unmatchedOutputs: outputs.filter((item) => !calls.has(item.call_id)).length };
}
export function createToolEventAudit() { return { upstream: new Map(), client: new Map(), truncated: false }; }
export function observeToolEvent(audit, side, event) {
  if (!audit) return;
  const items = event?.type === 'response.output_item.done' ? [event.item]
    : ['response.completed', 'response.incomplete'].includes(event?.type) ? event.response?.output || [] : [];
  for (const item of items) {
    if (!isCall(item)) continue;
    const id = hash(item.call_id);
    if (audit[side].size >= 128 && !audit[side].has(id)) { audit.truncated = true; continue; }
    audit[side].set(id, { type: item.type, nameHash: hash(item.name) });
  }
}
export function observeToolBlock(audit, side, block) {
  for (const line of block.split(String.fromCharCode(10))) {
    if (!line.trim().startsWith('data:')) continue;
    try { observeToolEvent(audit, side, JSON.parse(line.trim().slice(5))); } catch {}
  }
}
export function summarizeToolEvents(audit) {
  if (!audit) return undefined;
  return { upstream: [...audit.upstream.values()], client: [...audit.client.values()],
    missingClientCalls: [...audit.upstream.keys()].filter((id) => !audit.client.has(id)).length,
    unexpectedClientCalls: [...audit.client.keys()].filter((id) => !audit.upstream.has(id)).length, truncated: audit.truncated };
}
