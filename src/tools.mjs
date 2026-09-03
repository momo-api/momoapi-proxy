function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeName(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "_");
}

function toFunction(tool, namespace) {
  if (!tool || typeof tool !== "object") return null;
  const rawName = tool.name || tool.function?.name;
  if (!rawName) return null;
  const name = namespace ? `${safeName(namespace)}__${safeName(rawName)}` : safeName(rawName);
  const custom = tool.type === "custom";
  const parameters = custom
    ? {
      type: "object",
      properties: {
        input: { type: "string", description: "The complete raw input for this custom tool. Do not wrap it in JSON." },
      },
      required: ["input"],
      additionalProperties: false,
    }
    : tool.parameters || tool.input_schema || tool.function?.parameters || { type: "object", properties: {} };
  return {
    name,
    originalName: String(rawName),
    namespace: namespace || null,
    kind: custom ? "custom" : "function",
    description: custom
      ? `${tool.description || "Codex custom tool"}\nReturn the complete freeform payload in the required input string exactly as the tool expects.`
      : tool.description || tool.function?.description || "Codex tool",
    parameters,
  };
}

export function extractFunctions(request) {
  const result = [];
  const visit = (tool, namespace = null) => {
    if (!tool || typeof tool !== "object") return;
    if (tool.type === "namespace") {
      for (const child of asArray(tool.tools)) visit(child, tool.namespace || tool.name || namespace);
      return;
    }
    if (tool.type === "additional_tools") {
      for (const child of asArray(tool.tools)) visit(child, namespace);
      return;
    }
    if (tool.type === "function" || tool.function?.name || tool.name) {
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
  return functions.find((tool) => tool.name === name) || { name, originalName: name, namespace: null };
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
