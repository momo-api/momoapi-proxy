import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const PNG_PATH = join(ROOT, "..", "services", "nginx", "site", "momo-favicon.png");
const ICO_PATH = join(ROOT, "app.ico");

const pngBuf = readFileSync(PNG_PATH);

// Create standard Windows ICO format from PNG buffer
// Header: 2 bytes reserved (0), 2 bytes type (1 for icon), 2 bytes image count (1)
// Directory entry: 16 bytes (width, height, colorCount, reserved, planes, bpp, bytesInRes, imageOffset)
// Image data: raw PNG buffer (Windows Vista+ supports embedded PNG in ICO natively)

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // icon type
header.writeUInt16LE(1, 4); // count = 1

const dir = Buffer.alloc(16);
dir.writeUInt8(0, 0); // 0 means 256px width
dir.writeUInt8(0, 1); // 0 means 256px height
dir.writeUInt8(0, 2); // color count
dir.writeUInt8(0, 3); // reserved
dir.writeUInt16LE(1, 4); // color planes
dir.writeUInt16LE(32, 6); // bits per pixel
dir.writeUInt32LE(pngBuf.length, 8); // image size
dir.writeUInt32LE(6 + 16, 12); // image offset

const icoBuf = Buffer.concat([header, dir, pngBuf]);
writeFileSync(ICO_PATH, icoBuf);

console.log(`✅ Pure binary ICO written to ${ICO_PATH} (${icoBuf.length} bytes)`);
