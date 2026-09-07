function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeName(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "_");
}

export const BUILTIN_FUNCTIONS_NAMESPACE = "functions";

function toFunction(tool, namespace) {
  if (!tool || typeof tool !== "object") return null;
  const rawName = tool.name || tool.function?.name;
  if (!rawName) return null;
  const effectiveNamespace = (!namespace || namespace === BUILTIN_FUNCTIONS_NAMESPACE) ? null : namespace;
  const name = effectiveNamespace ? `${safeName(effectiveNamespace)}__${safeName(rawName)}` : safeName(rawName);
  const custom = tool.type === "custom" || rawName === "exec" || rawName === "apply_patch";
  const inputDescription = rawName === "exec"
    ? "JavaScript source for unified exec. Use await tools.exec_command(...) for shell commands and text(...) to return textual output; do not provide a bare shell command."
    : (rawName === "apply_patch"
      ? "Raw tool input. For apply_patch, begin exactly with `*** Begin Patch` (no trailing `***`), then use its standard patch envelope."
      : "Raw freeform input for this tool.");
  const parameters = custom
    ? {
      type: "object",
      properties: {
        input: { type: "string", description: inputDescription },
      },
      required: ["input"],
      additionalProperties: false,
    }
    : tool.parameters || tool.input_schema || tool.function?.parameters || { type: "object", properties: {} };
  return {
    name,
    originalName: String(rawName),
    namespace: effectiveNamespace || null,
    kind: custom ? "custom" : "function",
    description: custom
      ? `${tool.description || "Codex custom tool"}\n${inputDescription}`
      : tool.description || tool.function?.description || "Codex tool",
    parameters,
  };
}

export function extractFunctions(request) {
  const result = [];
  const visit = (tool, namespace = null) => {
    if (!tool || typeof tool !== "object") return;
    if (tool.type === "namespace") {
      const ns = tool.namespace || tool.name || namespace;
      const effectiveNs = (!ns || ns === BUILTIN_FUNCTIONS_NAMESPACE) ? null : ns;
      for (const child of asArray(tool.tools)) visit(child, effectiveNs);
      return;
    }
    if (tool.type === "additional_tools") {
      for (const child of asArray(tool.tools)) visit(child, namespace);
      return;
    }
    if (tool.type === "custom" || tool.type === "function" || tool.function?.name || tool.name) {
      const converted = toFunction(tool, namespace);
      if (converted) result.push(converted);
    }
  };

  const allTools = [
    ...asArray(request?.tools),
    ...asArray(request?.additional_tools),
  ];

  if (Array.isArray(request?.input)) {
    for (const item of request.input) {
      if (item && typeof item === "object") {
        if (item.type === "additional_tools" && Array.isArray(item.tools)) {
          allTools.push(...item.tools);
        } else if (Array.isArray(item.tools)) {
          allTools.push(...item.tools);
        }
      }
    }
  }

  for (const tool of allTools) visit(tool);
  return [...new Map(result.map((tool) => [tool.name, tool])).values()];
}

export function restoreToolName(name, functions) {
  if (!name || typeof name !== "string") return { name, originalName: name, namespace: null };
  const toolList = asArray(functions);

  // 1. 精确匹配 wire name
  const exact = toolList.find((tool) => tool.name === name);
  if (exact) return exact;

  // 2. 如果包含了 functions__ 或 functions/ 前缀，尝试去掉前缀匹配
  if (name.startsWith("functions__") || name.startsWith("functions/")) {
    const stripped = name.replace(/^functions[__/]/, "");
    const byStripped = toolList.find((tool) => tool.name === stripped || tool.originalName === stripped);
    if (byStripped) return byStripped;
  }

  // 3. 按 originalName 反向匹配 (例如 Gemini 返回了裸 exec，而声明的是 custom__exec 或 exec)
  const byOriginal = toolList.find((tool) => tool.originalName === name);
  if (byOriginal) return byOriginal;

  // 4. 按后缀名称反向匹配 (例如模型返回了裸名称，而声明的是 namespace__name)
  const bySuffix = toolList.find((tool) => tool.name && tool.name.endsWith(`__${name}`));
  if (bySuffix) return bySuffix;

  // 5. 特殊兼容: 如果声明了 custom exec / apply_patch，但模型返回了裸名或变体
  if (name === "exec" || name.endsWith("__exec") || name.endsWith("/exec")) {
    const customExec = toolList.find((tool) => tool.kind === "custom" && (tool.originalName === "exec" || tool.name === "exec" || tool.name.endsWith("__exec")));
    if (customExec) return customExec;
  }

  return { name, originalName: name, namespace: null };
}

export function parseDsmlCalls(text) {
  if (!text || typeof text !== "string" || !text.includes("<")) return [];
  const calls = [];
  const clean = text
    .replace(/<[\|\uFF5C]{2}DSML[\|\uFF5C]{2}/g, "<")
    .replace(/<\/[\|\uFF5C]{2}DSML[\|\uFF5C]{2}/g, "</");

  const invokeRegex = /<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
  let match;
  while ((match = invokeRegex.exec(clean)) !== null) {
    const name = match[1];
    const body = match[2] || "";
    const params = {};
    const paramRegex = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(body)) !== null) {
      const pName = paramMatch[1];
      const pVal = paramMatch[2] || "";
      params[pName] = pVal.trim();
    }
    calls.push({ name, arguments: params });
  }
  return calls;
}

export function stripDsmlMarkup(text) {
  if (!text || typeof text !== "string" || !text.includes("<")) return text;
  return text
    .replace(/<[\|\uFF5C]{2}DSML[\|\uFF5C]{2}[^>]*>[\s\S]*?<\/[\|\uFF5C]{2}DSML[\|\uFF5C]{2}[^>]*>/gi, "")
    .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls>/gi, "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
    .replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, "");
}
