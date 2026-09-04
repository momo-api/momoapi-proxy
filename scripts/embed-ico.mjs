import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const ICO_FILE = join(ROOT, "app.ico");
const OUT_FILE = join(ROOT, "src", "ico-binary.mjs");

const buf = readFileSync(ICO_FILE);
const b64 = buf.toString("base64");

const content = `// Auto-generated embedded app.ico binary
export const APP_ICO_BASE64 = "${b64}";
`;

writeFileSync(OUT_FILE, content, "utf8");
console.log(`✅ Embedded ${buf.length} bytes app.ico binary into ${OUT_FILE}`);
