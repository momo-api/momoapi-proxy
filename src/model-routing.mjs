const GEMINI_PREFIX = /^gemini-/;
const CLAUDE_PREFIX = /^claude-/;
const MIMO_PREFIX = /^mimo-/;
const MUSE_MODEL = "muse-auto";

export function resolveTargetModel(model) {
  if (model === MUSE_MODEL) return { targetModel: model, protocol: "muse" };
  if (GEMINI_PREFIX.test(model)) return { targetModel: model, protocol: "gemini" };
  if (CLAUDE_PREFIX.test(model)) return { targetModel: model, protocol: "claude" };
  if (MIMO_PREFIX.test(model) || model === "gpt-5.6-sol" || model === "gpt-5.6-luna" || model.endsWith("-sol") || model.endsWith("-luna") || model.endsWith("-responses")) {
    return { targetModel: model, protocol: "responses" };
  }
  return { targetModel: model, protocol: "chat" };
}
