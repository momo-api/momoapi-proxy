 // Responses tool compatibility: namespace tool flattening and custom tool conversion
 // Ported from OpenCodex for seamless Codex-Canvas and custom tool support in MOMO API.
 
 export const BUILTIN_FUNCTIONS_NAMESPACE = "functions";
 export const ROUTED_CUSTOM_TOOL_PASSTHROUGH = new Set(["apply_patch"]);
 
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
     restored.input = customToolInput(value.arguments);
     delete restored.arguments;
     changed = true;
   }
   return changed ? { value: restored, changed: true } : { value, changed: false };
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
