import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const SVG_PATH = join(ROOT, "..", "services", "nginx", "logo.svg");
const FAVICON_PNG = join(ROOT, "..", "services", "nginx", "site", "momo-favicon.png");
const ICO_PATH = join(ROOT, "app.ico");

console.log("=== 1. Rendering pure transparent PNG from SVG ===");
const svgContent = readFileSync(SVG_PATH, "utf8");

const resvg256 = new Resvg(svgContent, {
  fitTo: { mode: "width", value: 256 },
  background: "rgba(0, 0, 0, 0)", // 100% transparent background
});
const png256 = resvg256.render().asPng();
writeFileSync(FAVICON_PNG, png256);
console.log(`✅ Pure transparent 256x256 PNG written to ${FAVICON_PNG}`);

console.log("=== 2. Generating multi-resolution true-alpha ICO ===");
const icoBuf = await pngToIco(FAVICON_PNG);
writeFileSync(ICO_PATH, icoBuf);
console.log(`✅ Pure transparent multi-resolution ICO written to ${ICO_PATH} (${icoBuf.length} bytes)`);
