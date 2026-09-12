const GEMINI_PREFIX = /^gemini-/;
const CLAUDE_PREFIX = /^claude-/;
const MUSE_PREFIX = /^muse-/;

export function resolveTargetModel(model) {
  if (GEMINI_PREFIX.test(model)) return { targetModel: model, protocol: "gemini" };
  if (CLAUDE_PREFIX.test(model)) return { targetModel: model, protocol: "claude" };
  if (MUSE_PREFIX.test(model) || model === "gpt-5.6-sol" || model === "gpt-5.6-luna" || model.endsWith("-sol") || model.endsWith("-luna") || model.endsWith("-responses")) {
    return { targetModel: model, protocol: "responses" };
  }
  return { targetModel: model, protocol: "chat" };
}
