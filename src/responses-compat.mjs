// Responses tool compatibility: namespace tool flattening and custom tool conversion
// Ported from OpenCodex for seamless Codex-Canvas and custom tool support in MOMO API.

export const BUILTIN_FUNCTIONS_NAMESPACE = "functions";
export const ROUTED_CUSTOM_TOOL_PASSTHROUGH = new Set(["apply_patch"]);
const FREEFORM_WRAP_PREFIX = '{"input":"';
const FREEFORM_WRAP_PREFIX_RE = /^\s*\{\s*"input"\s*:\s*"/;

export function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function namespacedToolName(namespace, name) {
  if (!namespace || namespace === BUILTIN_FUNCTIONS_NAMESPACE) return name;
  return `${namespace}__${name}`;
}

export function isRepresentableName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

export function collectResponsesToolGroups(body) {
  if (!isPlainObject(body)) return [];
  const groups = [];
  if (Array.isArray(body.tools)) groups.push(body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
        groups.push(item.tools);
      }
    }
  }
  return groups;
}

function parseNamespaceGroup(tool) {
  if (!isPlainObject(tool) || tool.type !== "namespace" || !isRepresentableName(tool.name) || !Array.isArray(tool.tools)) {
    return undefined;
  }
  const children = [];
  for (const child of tool.tools) {
    if (!isPlainObject(child) || child.type === "namespace" || !isRepresentableName(child.name)) continue;
    children.push(child);
  }
  return { namespace: tool.name, children };
}

function loweredIdentity(namespace, name) {
  return namespace === BUILTIN_FUNCTIONS_NAMESPACE
    ? `${BUILTIN_FUNCTIONS_NAMESPACE}\u0000${name}`
    : `${namespace}\u0000${name}`;
}

function loweredWireName(namespace, name) {
  return namespace === BUILTIN_FUNCTIONS_NAMESPACE ? name : namespacedToolName(namespace, name);
}

function addSelector(selectors, selector, wireName) {
  const current = selectors.get(selector);
  if (current === undefined) selectors.set(selector, wireName);
  else if (current !== wireName) selectors.set(selector, null);
}

export function buildNamespaceRewritePlan(groups) {
  const aliases = new Map();
  const bareWireNames = new Set();
  const identities = new Map();
  const selectors = new Map();
  const wireOwners = new Map();

  for (const group of groups) {
    for (const tool of group) {
      if (isPlainObject(tool) && tool.type !== "namespace" && isRepresentableName(tool.name)) {
        wireOwners.set(tool.name, loweredIdentity(BUILTIN_FUNCTIONS_NAMESPACE, tool.name));
        bareWireNames.add(tool.name);
        addSelector(selectors, tool.name, tool.name);
      }
    }
  }

  for (const group of groups) {
    for (const tool of group) {
      const parsed = parseNamespaceGroup(tool);
      if (!parsed) continue;
      for (const child of parsed.children) {
        const childName = child.name;
        const identity = loweredIdentity(parsed.namespace, childName);
        const wireName = loweredWireName(parsed.namespace, childName);
        wireOwners.set(wireName, identity);
        identities.set(identity, wireName);
        addSelector(selectors, wireName, wireName);
        addSelector(selectors, `${parsed.namespace}.${childName}`, wireName);
        addSelector(selectors, childName, wireName);
        if (parsed.namespace !== BUILTIN_FUNCTIONS_NAMESPACE) {
          aliases.set(wireName, { namespace: parsed.namespace, name: childName });
        }
      }
    }
  }

  return { aliases, bareWireNames, identities, selectors };
}

function rewriteToolList(tools, plan, emitted) {
  let changed = false;
  const rewritten = [];
  for (const tool of tools) {
    if (isPlainObject(tool) && tool.type === "namespace") {
      changed = true;
      const parsed = parseNamespaceGroup(tool);
      if (!parsed) continue;
      for (const child of parsed.children) {
        const wireName = plan.identities.get(loweredIdentity(parsed.namespace, child.name));
        if (
          wireName === undefined
          || (parsed.namespace === BUILTIN_FUNCTIONS_NAMESPACE && plan.bareWireNames.has(wireName))
          || emitted.has(wireName)
        ) continue;
        emitted.add(wireName);
        const childType = child.type || "function";
        rewritten.push(wireName === child.name ? { ...child, type: childType } : { ...child, name: wireName, type: childType });
      }
      continue;
    }
    if (isPlainObject(tool) && isRepresentableName(tool.name)) {
      if (emitted.has(tool.name)) {
        changed = true;
        continue;
      }
      emitted.add(tool.name);
    }
    const toolType = tool.type || "function";
    rewritten.push(tool.type === toolType ? tool : { ...tool, type: toolType });
  }
  return changed ? rewritten : tools;
}

function rewriteNamedSelector(value, plan, bareFallback) {
  if (!isPlainObject(value) || typeof value.name !== "string") return value;
  if (typeof value.namespace !== "string") {
    if (!bareFallback) return value;
    const wireName = plan.selectors.get(value.name) ?? undefined;
    return wireName === undefined || wireName === value.name ? value : { ...value, name: wireName };
  }
  const { namespace, ...rest } = value;
  const wireName = plan.identities.get(loweredIdentity(namespace, value.name))
    ?? loweredWireName(namespace, value.name);
  return { ...rest, name: wireName };
}

function rewriteToolChoice(value, plan) {
  if (!isPlainObject(value)) return value;
  if ((value.type === "function" || value.type === "custom") && typeof value.name === "string") {
    return rewriteNamedSelector(value, plan, true);
  }
  if (value.type !== "allowed_tools" || !Array.isArray(value.tools)) return value;
  let changed = false;
  const tools = value.tools.map((tool) => {
    if (!isPlainObject(tool) || typeof tool.name !== "string") return tool;
    const rewritten = rewriteNamedSelector(tool, plan, true);
    changed ||= rewritten !== tool;
    return rewritten;
  });
  return changed ? { ...value, tools } : value;
}

function rewriteInputItem(item, plan, emitted) {
  if (!isPlainObject(item)) return item;
  if (item.type === "additional_tools" && Array.isArray(item.tools)) {
    const tools = rewriteToolList(item.tools, plan, emitted);
    return tools === item.tools ? item : { ...item, tools };
  }
  if (
    (item.type === "function_call" || item.type === "custom_tool_call")
    && typeof item.name === "string"
  ) return rewriteNamedSelector(item, plan, false);
  return item;
}

export function rewriteRoutedNamespaceToolsForUpstream(body) {
  if (!isPlainObject(body)) return { body, aliases: new Map() };
  const groups = collectResponsesToolGroups(body);
  const plan = buildNamespaceRewritePlan(groups);

  const emitted = new Set();
  const tools = Array.isArray(body.tools) ? rewriteToolList(body.tools, plan, emitted) : body.tools;

  let input = body.input;
  if (Array.isArray(body.input)) {
    let inputChanged = false;
    const rewrittenInput = body.input.map((item) => {
      const next = rewriteInputItem(item, plan, emitted);
      if (next !== item) inputChanged = true;
      return next;
    });
    if (inputChanged) input = rewrittenInput;
  }

  const toolChoice = rewriteToolChoice(body.tool_choice, plan);
  return {
    body: {
      ...body,
      ...(tools !== body.tools ? { tools } : {}),
      ...(input !== body.input ? { input } : {}),
      ...(toolChoice !== body.tool_choice ? { tool_choice: toolChoice } : {}),
    },
    aliases: plan.aliases,
  };
}

export function restoreRoutedNamespaceCalls(value, aliases) {
  if (Array.isArray(value)) {
    let changed = false;
    const restored = value.map((entry) => {
      const result = restoreRoutedNamespaceCalls(entry, aliases);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: restored, changed: true } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };

  let changed = false;
  const restored = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = restoreRoutedNamespaceCalls(entry, aliases);
    restored[key] = result.value;
    changed ||= result.changed;
  }

  if (
    (value.type === "function_call" || value.type === "custom_tool_call" || value.type === "response.function_call_arguments.delta" || value.type === "response.function_call_arguments.done")
    && typeof value.name === "string"
  ) {
    const identity = aliases.get(value.name);
    if (identity) {
      restored.name = identity.name;
      restored.namespace = identity.namespace;
      changed = true;
    }
  }
  return changed ? { value: restored, changed: true } : { value, changed: false };
}

// -------------------------------------------------------------
// Custom Tool Compatibility (e.g. exec, apply_patch)
// -------------------------------------------------------------

function customToolInput(argumentsText) {
  if (typeof argumentsText !== "string") return "";
  try {
    const parsed = JSON.parse(argumentsText);
    if (isPlainObject(parsed) && typeof parsed.input === "string") return parsed.input;
  } catch {}
  return argumentsText;
}

export function collectRoutedCustomToolNames(body) {
  const names = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isPlainObject(value)) return;
    if (
      value.type === "custom"
      && typeof value.name === "string"
      && !ROUTED_CUSTOM_TOOL_PASSTHROUGH.has(value.name)
    ) {
      names.add(value.name);
    }
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(body);
  return names;
}

function collectConvertedCallIds(value, names, out) {
  if (Array.isArray(value)) {
    for (const entry of value) collectConvertedCallIds(entry, names, out);
    return;
  }
  if (!isPlainObject(value)) return;
  if (
    (value.type === "custom_tool_call" || value.type === "function_call")
    && typeof value.name === "string"
    && names.has(value.name)
    && typeof value.call_id === "string"
  ) {
    out.add(value.call_id);
  }
  for (const entry of Object.values(value)) collectConvertedCallIds(entry, names, out);
}

function rewriteCustomForUpstream(value, names, callIds) {
  if (Array.isArray(value)) return value.map((entry) => rewriteCustomForUpstream(entry, names, callIds));
  if (!isPlainObject(value)) return value;

  if (value.type === "custom" && typeof value.name === "string" && names.has(value.name)) {
    const { format: _format, ...rest } = value;
    const inputDescription = value.name === "exec"
      ? "JavaScript source for unified exec. Use await tools.exec_command(...) for shell commands and text(...) to return textual output; do not provide a bare shell command."
      : "Raw input for this client-executed custom tool.";
    return {
      ...rest,
      type: "function",
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: inputDescription,
          },
        },
        required: ["input"],
        additionalProperties: false,
      },
    };
  }

  if (
    value.type === "custom_tool_call"
    && typeof value.name === "string"
    && names.has(value.name)
  ) {
    const { input, id: _id, ...rest } = value;
    return {
      ...rest,
      type: "function_call",
      arguments: JSON.stringify({ input: typeof input === "string" ? input : "" }),
    };
  }

  if (
    value.type === "custom_tool_call_output"
    && typeof value.call_id === "string"
    && callIds.has(value.call_id)
  ) {
    return { ...value, type: "function_call_output" };
  }

  let changed = false;
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    const rewritten = rewriteCustomForUpstream(entry, names, callIds);
    next[key] = rewritten;
    changed ||= rewritten !== entry;
  }
  return changed ? next : value;
}

export function rewriteRoutedCustomToolsForUpstream(body) {
  const conversionNames = collectRoutedCustomToolNames(body);
  if (conversionNames.size === 0) return { body, names: conversionNames };
  const callIds = new Set();
  collectConvertedCallIds(body, conversionNames, callIds);
  return { body: rewriteCustomForUpstream(body, conversionNames, callIds), names: conversionNames };
}

export function restoreRoutedCustomCalls(value, names) {
  if (Array.isArray(value)) {
    let changed = false;
    const restored = value.map((entry) => {
      const result = restoreRoutedCustomCalls(entry, names);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: restored, changed: true } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };

  let changed = false;
  const restored = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = restoreRoutedCustomCalls(entry, names);
    restored[key] = result.value;
    changed ||= result.changed;
  }

  if (value.type === "function_call" && typeof value.name === "string" && names.has(value.name)) {
    restored.type = "custom_tool_call";
    restored.id = customToolItemId(value.id);
    restored.input = customToolInput(value.arguments);
    delete restored.arguments;
    changed = true;
  }
  return changed ? { value: restored, changed: true } : { value, changed: false };
}

export function customToolItemId(id) {
  if (typeof id !== "string") return id;
  return id.startsWith("fc_") ? `ctc_${id.slice(3)}` : id;
}

export function unwrapRoutedCustomToolArguments(argumentsText) {
  return customToolInput(argumentsText);
}

export function restoreAllRoutedCallsInJson(text, aliases, customNames) {
  if ((!aliases || aliases.size === 0) && (!customNames || customNames.size === 0)) {
    return text;
  }
  try {
    const payload = JSON.parse(text);
    let current = payload;
    if (aliases && aliases.size > 0) {
      current = restoreRoutedNamespaceCalls(current, aliases).value;
    }
    if (customNames && customNames.size > 0) {
      current = restoreRoutedCustomCalls(current, customNames).value;
    }
    return JSON.stringify(current);
  } catch {
    return text;
  }
}

function partialCustomToolInput(argumentsText) {
  const match = FREEFORM_WRAP_PREFIX_RE.exec(argumentsText);
  if (!match) return null;
  const body = argumentsText.slice(match[0].length);
  let output = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '"') break;
    if (char !== "\\") {
      output += char;
      continue;
    }
    const escaped = body[index + 1];
    if (escaped === undefined) break;
    index += 1;
    if (escaped === "n") output += "\n";
    else if (escaped === "t") output += "\t";
    else if (escaped === "r") output += "\r";
    else if (escaped === "b") output += "\b";
    else if (escaped === "f") output += "\f";
    else if (escaped === "u") {
      const hex = body.slice(index + 1, index + 5);
      if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    } else output += escaped;
  }
  return output;
}

function sseDataPayload(block) {
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return data.length > 0 ? data.join("\n") : null;
}

function replaceSseDataPayload(block, payload) {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const rewritten = [];
  let replaced = false;
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      rewritten.push(line);
      continue;
    }
    if (!replaced) {
      rewritten.push(`data: ${payload}`);
      replaced = true;
    }
  }
  return replaced ? rewritten.join(newline) : block;
}

function replaceSseEventName(block, type) {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (!replaced && line.startsWith("event:")) {
      replaced = true;
      return `event: ${type}`;
    }
    return line;
  });
  if (!replaced) {
    next.unshift(`event: ${type}`);
  }
  return next.join(newline);
}

export function createRoutedCustomToolRestoreBlockRewrite(names) {
  if (!names || names.size === 0) {
    return (block) => [block];
  }
  const itemNames = new Map();
  const ordinaryItemIds = new Set();
  const openCalls = new Map();
  let pendingArguments = [];

  const releaseCall = (itemId) => {
    openCalls.delete(itemId);
  };

  const takePendingArguments = (itemId, outputIndex) => {
    const matched = [];
    const remaining = [];
    for (const pending of pendingArguments) {
      const matches = pending.itemId !== undefined
        ? itemId !== undefined && pending.itemId === itemId
        : outputIndex !== undefined && pending.outputIndex === outputIndex;
      (matches ? matched : remaining).push(pending);
    }
    pendingArguments = remaining;
    return matched.map((pending) => {
      if (pending.itemId !== undefined || itemId === undefined) return pending.block;
      const payload = sseDataPayload(pending.block);
      if (payload === null) return pending.block;
      try {
        const parsed = JSON.parse(payload);
        if (!isPlainObject(parsed)) return pending.block;
        return replaceSseDataPayload(pending.block, JSON.stringify({ ...parsed, item_id: itemId }));
      } catch {
        return pending.block;
      }
    });
  };

  const rewrite = (block) => {
    const payload = sseDataPayload(block);
    if (payload === null || payload === "[DONE]") return [block];
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [block];
    }
    if (!isPlainObject(parsed)) return [block];

    const type = typeof parsed.type === "string" ? parsed.type : "";
    const outputIndex = typeof parsed.output_index === "number"
      && Number.isInteger(parsed.output_index)
      && parsed.output_index >= 0
      ? parsed.output_index
      : undefined;

    if (
      (type === "response.output_item.added" || type === "response.output_item.done")
      && isPlainObject(parsed.item)
      && parsed.item.type === "function_call"
      && typeof parsed.item.name === "string"
    ) {
      const upstreamItemId = typeof parsed.item.id === "string" ? parsed.item.id : undefined;
      const wireName = parsed.item.name;
      const routed = wireName !== undefined && names.has(wireName);
      if (upstreamItemId) {
        if (routed) {
          itemNames.set(upstreamItemId, parsed.item.name);
          ordinaryItemIds.delete(upstreamItemId);
        } else {
          ordinaryItemIds.add(upstreamItemId);
        }
        if (routed && type === "response.output_item.added") {
          openCalls.set(upstreamItemId, { argumentsText: "", emittedInput: "" });
        }
      }
      const pending = takePendingArguments(upstreamItemId, outputIndex);
      if (!routed) {
        if (type === "response.output_item.done" && upstreamItemId) ordinaryItemIds.delete(upstreamItemId);
        return [...pending, block];
      }
      if (upstreamItemId && pending.length > 0 && !openCalls.has(upstreamItemId)) {
        openCalls.set(upstreamItemId, { argumentsText: "", emittedInput: "" });
      }
      const restored = restoreRoutedCustomCalls(parsed, names);
      const restoredBlock = restored.changed
        ? replaceSseDataPayload(block, JSON.stringify(restored.value))
        : block;
      const replayed = pending.flatMap((pendingBlock) => rewrite(pendingBlock));
      if (type === "response.output_item.done" && upstreamItemId) releaseCall(upstreamItemId);
      return type === "response.output_item.added"
        ? [restoredBlock, ...replayed]
        : [...replayed, restoredBlock];
    }

    const upstreamItemId = typeof parsed.item_id === "string" ? parsed.item_id : undefined;
    const argumentEvent = type === "response.function_call_arguments.delta"
      || type === "response.function_call_arguments.done";
    if (argumentEvent && (!upstreamItemId || (!itemNames.has(upstreamItemId) && !ordinaryItemIds.has(upstreamItemId)))) {
      pendingArguments.push({ block, itemId: upstreamItemId, outputIndex });
      return [];
    }
    if (
      type === "response.function_call_arguments.delta"
      && upstreamItemId
      && itemNames.has(upstreamItemId)
    ) {
      const open = openCalls.get(upstreamItemId) || { argumentsText: "", emittedInput: "" };
      const delta = typeof parsed.delta === "string" ? parsed.delta : "";
      open.argumentsText += delta;
      openCalls.set(upstreamItemId, open);
      if (FREEFORM_WRAP_PREFIX.startsWith(open.argumentsText)) return [];
      const fullInput = partialCustomToolInput(open.argumentsText);
      if (fullInput === null) return [];
      if (!fullInput.startsWith(open.emittedInput) || fullInput.length === open.emittedInput.length) return [];
      const inputDelta = fullInput.slice(open.emittedInput.length);
      open.emittedInput = fullInput;
      const nextType = "response.custom_tool_call_input.delta";
      const next = {
        ...parsed,
        type: nextType,
        item_id: customToolItemId(upstreamItemId),
        delta: inputDelta,
      };
      return [replaceSseDataPayload(replaceSseEventName(block, nextType), JSON.stringify(next))];
    }

    if (
      type === "response.function_call_arguments.done"
      && upstreamItemId
      && itemNames.has(upstreamItemId)
    ) {
      const nextType = "response.custom_tool_call_input.done";
      const source = typeof parsed.arguments === "string"
        ? parsed.arguments
        : openCalls.get(upstreamItemId)?.argumentsText || "";
      const { arguments: _arguments, ...rest } = parsed;
      const next = {
        ...rest,
        type: nextType,
        item_id: customToolItemId(upstreamItemId),
        input: unwrapRoutedCustomToolArguments(source),
      };
      return [replaceSseDataPayload(replaceSseEventName(block, nextType), JSON.stringify(next))];
    }

    const restored = restoreRoutedCustomCalls(parsed, names);
    const terminal = type === "response.completed" || type === "response.failed" || type === "response.incomplete";
    if (terminal) {
      openCalls.clear();
      pendingArguments = [];
      itemNames.clear();
      ordinaryItemIds.clear();
    }
    return restored.changed
      ? [replaceSseDataPayload(block, JSON.stringify(restored.value))]
      : [block];
  };

  return rewrite;
}

export const TOOL_SEARCH_FUNCTION_NAME = "tool_search";
export const TOOL_SEARCH_DEFAULT_DESCRIPTION = "Search for additional tools to load for the next turn.";

export function toolSearchDescription(tool) {
  return isPlainObject(tool) && typeof tool.description === "string"
    ? tool.description
    : TOOL_SEARCH_DEFAULT_DESCRIPTION;
}

export function toolSearchParameters(tool) {
  if (isPlainObject(tool) && isPlainObject(tool.parameters)) return tool.parameters;
  return {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query for tools to load." },
      limit: { type: "number", description: "Maximum number of tools to return." },
    },
    required: ["query"],
  };
}

export function rewriteRoutedToolSearchForUpstream(body) {
  const names = new Set();
  if (!isPlainObject(body)) return { body, names };

  const hasSearch = (tools) => Array.isArray(tools) && tools.some((t) => isPlainObject(t) && t.type === "tool_search");
  const topLevelSearch = hasSearch(body.tools);
  const inputItems = Array.isArray(body.input) ? body.input : [];
  const additionalSearch = inputItems.some((item) => isPlainObject(item) && item.type === "additional_tools" && hasSearch(item.tools));
  const historySearch = inputItems.some((item) => isPlainObject(item) && (item.type === "tool_search_call" || item.type === "tool_search_output"));

  if (!topLevelSearch && !additionalSearch && !historySearch) return { body, names };

  const wireName = TOOL_SEARCH_FUNCTION_NAME;
  names.add(wireName);

  const rewriteList = (tools) => {
    if (!Array.isArray(tools)) return tools;
    return tools.map((t) => {
      if (!isPlainObject(t) || t.type !== "tool_search") return t;
      const { execution, defer_loading, ...rest } = t;
      return {
        ...rest,
        type: "function",
        name: wireName,
        description: toolSearchDescription(t),
        parameters: toolSearchParameters(t),
      };
    });
  };

  let tools = rewriteList(body.tools);
  let input = Array.isArray(body.input) ? body.input.map((item) => {
    if (!isPlainObject(item)) return item;
    if (item.type === "additional_tools" && Array.isArray(item.tools)) {
      return { ...item, tools: rewriteList(item.tools) };
    }
    if (item.type === "tool_search_call") {
      const { execution, arguments: args, id, ...rest } = item;
      return {
        ...rest,
        type: "function_call",
        name: wireName,
        arguments: typeof args === "string" ? args : JSON.stringify(args || {}),
      };
    }
    if (item.type === "tool_search_output") {
      return {
        type: "function_call_output",
        call_id: item.call_id || "call_unknown",
        output: typeof item.output === "string" ? item.output : JSON.stringify(item.tools || item.output || {}),
      };
    }
    return item;
  }) : body.input;

  return {
    body: {
      ...body,
      ...(tools !== body.tools ? { tools } : {}),
      ...(input !== body.input ? { input } : {}),
    },
    names,
  };
}

export function restoreRoutedToolSearchCalls(value, names) {
  if (Array.isArray(value)) {
    let changed = false;
    const restored = value.map((entry) => {
      const res = restoreRoutedToolSearchCalls(entry, names);
      changed ||= res.changed;
      return res.value;
    });
    return changed ? { value: restored, changed: true } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };

  let changed = false;
  const restored = {};
  for (const [k, v] of Object.entries(value)) {
    const res = restoreRoutedToolSearchCalls(v, names);
    restored[k] = res.value;
    changed ||= res.changed;
  }

  if (value.type === "function_call" && typeof value.name === "string" && names.has(value.name)) {
    restored.type = "tool_search_call";
    restored.execution = "client";
    try { restored.arguments = typeof value.arguments === "string" ? JSON.parse(value.arguments) : value.arguments; } catch { restored.arguments = {}; }
    delete restored.name;
    changed = true;
  }
  return changed ? { value: restored, changed: true } : { value, changed: false };
}
