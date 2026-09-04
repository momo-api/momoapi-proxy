import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_JSON_PATH = join(__dirname, "bundled-model-template.json");

export const DESKTOP_COMPATIBILITY_ALIASES = [
  {
    slug: "gpt-5.6-sol",
    targetModel: "deepseek-v4-pro",
    display_name: "MOMO DeepSeek V4 Pro",
    description: "MOMO DeepSeek V4 Pro (Desktop Compatibility Slot)",
    default_reasoning_level: "high",
    supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "medium", description: "Balanced" }, { effort: "high", description: "Deep" }],
    visibility: "list",
  },
  {
    slug: "gpt-5.6-terra",
    targetModel: "claude-opus-4-6-thinking",
    display_name: "MOMO Claude Opus 4.6 Thinking",
    description: "MOMO Claude Opus 4.6 Thinking (Desktop Compatibility Slot)",
    default_reasoning_level: "high",
    supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "medium", description: "Balanced" }, { effort: "high", description: "Deep" }, { effort: "max", description: "Maximum thinking" }],
    visibility: "list",
  },
  {
    slug: "gpt-5.6-luna",
    targetModel: "gemini-3.7-flash",
    display_name: "MOMO Gemini 3.7 Flash",
    description: "MOMO Gemini 3.7 Flash (Desktop Compatibility Slot)",
    default_reasoning_level: "high",
    supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "medium", description: "Balanced" }, { effort: "high", description: "Deep" }],
    visibility: "list",
  },
];

const EFFORT_DESCRIPTIONS = {
  none: "None",
  minimal: "Minimal",
  low: "Fast",
  medium: "Balanced",
  high: "Deep",
  xhigh: "Extra deep",
  max: "Maximum thinking",
  ultra: "Ultra deep",
};

export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

export function catalogPath(env = process.env) {
  return join(codexHome(env), "model-catalogs", "momo-codex-bridge.json");
}

let cachedTemplate = null;

function getBundledTemplate() {
  if (cachedTemplate) return cachedTemplate;
  if (existsSync(BUNDLED_JSON_PATH)) {
    try {
      cachedTemplate = JSON.parse(readFileSync(BUNDLED_JSON_PATH, "utf8"));
      return cachedTemplate;
    } catch {}
  }
  try {
    const raw = execFileSync("codex", ["debug", "models", "--bundled"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const catalog = JSON.parse(raw);
    const found = catalog.models?.find((model) => model.slug === "gpt-5.5") || catalog.models?.[0];
    if (found) {
      cachedTemplate = found;
      return cachedTemplate;
    }
  } catch {}
  cachedTemplate = {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "MOMO Codex model.",
    default_reasoning_level: "high",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "Deep" }
    ],
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 100,
    context_window: 272000,
    max_context_window: 872000,
    effective_context_window_percent: 95,
    tool_mode: "code_mode_only",
    support_verbosity: true,
    default_verbosity: "low",
    default_reasoning_summary: "none",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    supports_image_detail_original: true,
    supports_search_tool: true,
    use_responses_lite: true,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    truncation_policy: { mode: "tokens", limit: 10000 },
    input_modalities: ["text", "image"],
    experimental_supported_tools: [],
    multi_agent_version: "v2",
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    base_instructions: "You are Codex, an agent based on GPT-5. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.",
    model_messages: {
      instructions_template: "You are Codex, an agent based on GPT-5. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled."
    },
    availability_nux: null,
    upgrade: null
  };
  return cachedTemplate;
}

function displayName(model) {
  return "MOMO " + model.id.replace(/(^|[-_])(\w)/g, (_, prefix, letter) => prefix + letter.toUpperCase());
}

function status(model) {
  return model.agent_status || model.agentStatus || "experimental";
}

function isImageOrNonText(model) {
  if (!model?.id) return true;
  const id = model.id.toLowerCase();
  if (id.includes("-image") || id.includes("imagine") || id.includes("flux") || id.includes("midjourney") || id.includes("dall-e") || id.includes("sora")) {
    return true;
  }
  if (Array.isArray(model.capabilities) && model.capabilities.length > 0) {
    if (!model.capabilities.includes("text") && (model.capabilities.includes("image_generation") || model.capabilities.includes("video_generation"))) {
      return true;
    }
  }
  return false;
}

function parseReasoningLevels(model, fallback) {
  const r = model.reasoning || {};
  if (r.state === "unsupported") {
    return { default_reasoning_level: null, supported_reasoning_levels: [] };
  }
  if (Array.isArray(r.efforts) && r.efforts.length > 0) {
    const levels = r.efforts.map((effort) => ({
      effort,
      description: EFFORT_DESCRIPTIONS[effort] || effort,
    }));
    const defaultEffort = r.default_effort || r.defaultEffort || levels[levels.length - 1]?.effort || "high";
    return { default_reasoning_level: defaultEffort, supported_reasoning_levels: levels };
  }
  if (Array.isArray(model.supported_reasoning_levels) && model.supported_reasoning_levels.length > 0) {
    return {
      default_reasoning_level: model.default_reasoning_level || "high",
      supported_reasoning_levels: model.supported_reasoning_levels,
    };
  }
  return {
    default_reasoning_level: fallback.default_reasoning_level || "high",
    supported_reasoning_levels: fallback.supported_reasoning_levels || [],
  };
}

export function getModelFamily(slug) {
  if (!slug) return 4;
  const s = slug.toLowerCase();
  if (s.startsWith("gpt-") || s.startsWith("codex") || s.startsWith("o1") || s.startsWith("o3") || s.startsWith("o4") || s.startsWith("momo/gpt-")) {
    return 0; // 0: gpt
  }
  if (s.startsWith("claude-") || s.startsWith("momo/claude-") || s.startsWith("anthropic/")) {
    return 1; // 1: claude
  }
  if (s.startsWith("gemini-") || s.startsWith("momo/gemini-") || s.startsWith("google/")) {
    return 2; // 2: gemini
  }
  if (s.startsWith("deepseek-") || s.startsWith("momo/deepseek-")) {
    return 3; // 3: deepseek
  }
  return 4; // 4: other
}

export function sortModels(models) {
  return [...models].sort((a, b) => {
    const slugA = a.id || a.slug || "";
    const slugB = b.id || b.slug || "";
    const famA = getModelFamily(slugA);
    const famB = getModelFamily(slugB);
    if (famA !== famB) return famA - famB;
    return slugA.localeCompare(slugB, undefined, { numeric: true, sensitivity: "base" });
  });
}

export function buildCatalog(models, { includeDesktopAliases = true } = {}) {
  const template = getBundledTemplate();
  const filtered = (models || [])
    .filter((model) => model?.id && status(model) !== "hidden" && status(model) !== "image" && status(model) !== "video" && !isImageOrNonText(model));

  const sorted = sortModels(filtered);
  const items = sorted.map((model, index) => {
    const reasoning = parseReasoningLevels(model, template);
    return {
      ...structuredClone(template),
      slug: model.id,
      display_name: model.display_name || displayName(model),
      description: model.description || ("MOMO model (" + (model.provider || "gateway") + ")."),
      visibility: status(model) !== "hidden" ? "list" : "hide",
      priority: 100 + index * 10,
      context_window: model.context_window || template.context_window || 272000,
      max_context_window: model.max_context_window || template.max_context_window || 872000,
      tool_mode: "code_mode_only",
      supported_in_api: true,
      availability_nux: null,
      support_verbosity: true,
      default_verbosity: "low",
      default_reasoning_level: reasoning.default_reasoning_level,
      supported_reasoning_levels: reasoning.supported_reasoning_levels,
    };
  });

  if (includeDesktopAliases) {
    const existingSlugs = new Set(items.map((i) => i.slug));
    for (const alias of DESKTOP_COMPATIBILITY_ALIASES) {
      if (!existingSlugs.has(alias.slug)) {
        items.push({
          ...structuredClone(template),
          slug: alias.slug,
          display_name: alias.display_name,
          description: alias.description,
          visibility: alias.visibility,
          priority: 120,
          tool_mode: "code_mode_only",
          supported_in_api: true,
          support_verbosity: true,
          default_verbosity: "low",
          default_reasoning_level: alias.default_reasoning_level,
          supported_reasoning_levels: alias.supported_reasoning_levels,
        });
      }
    }
    // Re-sort to maintain gpt -> claude -> gemini -> deepseek -> other
    items.sort((a, b) => {
      const famA = getModelFamily(a.slug);
      const famB = getModelFamily(b.slug);
      if (famA !== famB) return famA - famB;
      return a.slug.localeCompare(b.slug, undefined, { numeric: true, sensitivity: "base" });
    });
    // Reassign sequential priorities
    items.forEach((item, idx) => {
      item.priority = 100 + idx * 10;
    });
  }

  if (!items.length) throw new Error("MOMO returned no Codex-compatible models.");
  return { models: items };
}

export function writeCatalog(models, env = process.env, options = {}) {
  const target = catalogPath(env);
  mkdirSync(dirname(target), { recursive: true });
  const content = JSON.stringify(buildCatalog(models, options), null, 2) + "\n";
  const tempFile = target + "." + randomUUID() + ".tmp";
  writeFileSync(tempFile, content);
  try {
    renameSync(tempFile, target);
  } catch {
    writeFileSync(target, content);
  }
  return target;
}

export function readCatalog(env = process.env) {
  const target = catalogPath(env);
  return existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : null;
}
