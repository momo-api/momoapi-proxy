import { createHmac, timingSafeEqual } from "node:crypto";
import { safePartJson } from "./protocol-content.mjs";

const IMAGE_VISION_REFERENCE = /^momo-image-ref:v1:(img_[a-f0-9]{64}):([a-f0-9]{64})$/;

function imageVisionMac(assetId, secret) {
  return createHmac("sha256", String(secret || ""))
    .update("momo-image-ref:v1\n" + assetId)
    .digest("hex");
}

export function imageVisionReference(assetId, secret) {
  return `momo-image-ref:v1:${assetId}:${imageVisionMac(assetId, secret)}`;
}

export function verifyImageVisionReference(value, secret) {
  const match = IMAGE_VISION_REFERENCE.exec(String(value || ""));
  if (!match || !secret) return null;
  const expected = Buffer.from(imageVisionMac(match[1], secret), "hex");
  const actual = Buffer.from(match[2], "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? match[1] : null;
}

export function withImageVisionReferences(payload, secret) {
  return {
    ...payload,
    images: (payload?.images || []).map((image) => image?.vision_available
      ? { ...image, vision_reference: imageVisionReference(image.asset_id, secret) }
      : image),
  };
}

export function collectImageVisionReferences(value, output, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.length > 100_000) return;
    try { collectImageVisionReferences(JSON.parse(value), output, depth + 1); } catch { /* Only exact JSON tool metadata is eligible. */ }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageVisionReferences(item, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  if (typeof value.vision_reference === "string") output.add(value.vision_reference);
  for (const child of Object.values(value)) collectImageVisionReferences(child, output, depth + 1);
}

export async function expandCurrentImageVisionReferences(payload, imageAssetStore, secret) {
  const input = Array.isArray(payload?.input) ? payload.input : [];
  let currentTurnStart = 0;
  for (let index = input.length - 1; index >= 0; index--) {
    if (input[index]?.role === "user" || input[index]?.type === "input_text") { currentTurnStart = index; break; }
  }
  const expanded = [...input];
  for (let index = currentTurnStart; index < expanded.length; index++) {
    const item = expanded[index];
    if (item?.type !== "function_call_output" && item?.type !== "custom_tool_call_output") continue;
    const references = new Set();
    collectImageVisionReferences(item.output, references);
    const images = [];
    const seenUrls = new Set();
    for (const reference of references) {
      const assetId = verifyImageVisionReference(reference, secret);
      if (!assetId) continue;
      try {
        const sourceUrl = await imageAssetStore.sourceUrl(assetId);
        if (sourceUrl && !seenUrls.has(sourceUrl)) {
          seenUrls.add(sourceUrl);
          images.push({ type: "input_image", image_url: sourceUrl, detail: "high" });
        }
      } catch { /* Missing, expired, or damaged local assets are left as metadata only. */ }
    }
    if (images.length === 0) continue;
    const existingOutput = Array.isArray(item.output)
      ? item.output
      : [{ type: "input_text", text: typeof item.output === "string" ? item.output : safePartJson(item.output) }];
    expanded[index] = { ...item, output: [...existingOutput, ...images] };
  }
  return { ...payload, input: expanded };
}
