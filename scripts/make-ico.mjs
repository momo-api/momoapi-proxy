import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const PNG_PATH = join(ROOT, "..", "services", "nginx", "site", "momo-favicon.png");
const ICO_PATH = join(ROOT, "app.ico");

console.log("=== Generating Multi-Resolution True-Alpha ICO ===");
const icoBuf = await pngToIco(PNG_PATH);
writeFileSync(ICO_PATH, icoBuf);
console.log(`✅ Multi-resolution 32-bit Alpha ICO written: ${ICO_PATH} (${icoBuf.length} bytes)`);
