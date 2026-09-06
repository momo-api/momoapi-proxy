import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const trayExe = join(root, "dist", "MomoApiProxyTray.exe");
const outputFile = join(root, "src", "tray-binary.mjs");

const buffer = readFileSync(trayExe);
const content = `// Auto-generated embedded MomoApiProxyTray.exe binary
export const TRAY_EXE_BASE64 = "${buffer.toString("base64")}";
`;

writeFileSync(outputFile, content, "utf8");
console.log(`Embedded ${buffer.length} bytes from ${trayExe} into ${outputFile}`);
