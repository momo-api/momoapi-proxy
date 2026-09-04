import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const SVG_PATH = join(ROOT, "..", "services", "nginx", "logo.svg");
const ICO_PATH = join(ROOT, "app.ico");

const svgContent = readFileSync(SVG_PATH, "utf8");

// Standard sizes for Windows Icons
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function createDibFrame(width, height, rawPixels) {
  // rawPixels is RGBA from top-to-bottom
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(width, 4); // biWidth
  header.writeInt32LE(height * 2, 8); // biHeight (doubled for XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount = 32
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB

  // XOR mask: 32-bit BGRA from bottom-to-top
  const xorData = Buffer.alloc(width * height * 4);
  
  // AND mask: 1-bit per pixel, padded to 32-bit boundary per line, bottom-to-top
  const maskRowBytes = Math.ceil(width / 32) * 4;
  const andData = Buffer.alloc(maskRowBytes * height);

  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y; // Bottom-to-top for DIB
    for (let x = 0; x < width; x++) {
      const srcIdx = (srcY * width + x) * 4;
      const dstIdx = (y * width + x) * 4;

      const r = rawPixels[srcIdx];
      const g = rawPixels[srcIdx + 1];
      const b = rawPixels[srcIdx + 2];
      const a = rawPixels[srcIdx + 3];

      xorData[dstIdx] = b;     // B
      xorData[dstIdx + 1] = g; // G
      xorData[dstIdx + 2] = r; // R
      xorData[dstIdx + 3] = a; // A

      // If alpha is zero or transparent, set AND mask bit to 1
      if (a === 0) {
        const maskByteIdx = y * maskRowBytes + Math.floor(x / 8);
        const bitOffset = 7 - (x % 8);
        andData[maskByteIdx] |= (1 << bitOffset);
      }
    }
  }

  header.writeUInt32LE(xorData.length + andData.length, 20); // biSizeImage

  return Buffer.concat([header, xorData, andData]);
}

const frames = [];

for (const size of SIZES) {
  const resvg = new Resvg(svgContent, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0, 0, 0, 0)",
  });
  const rendered = resvg.render();
  const dib = createDibFrame(size, size, rendered.pixels);
  frames.push({
    size,
    data: dib,
  });
}

// Build ICONDIR + ICONDIRENTRY container
const count = frames.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type 1 = icon
header.writeUInt16LE(count, 4); // count

const entries = Buffer.alloc(count * 16);
let currentOffset = 6 + count * 16;

const bodyParts = [];

for (let i = 0; i < count; i++) {
  const frame = frames[i];
  const sizeByte = frame.size >= 256 ? 0 : frame.size;
  const entryOffset = i * 16;

  entries.writeUInt8(sizeByte, entryOffset + 0); // width
  entries.writeUInt8(sizeByte, entryOffset + 1); // height
  entries.writeUInt8(0, entryOffset + 2); // color count
  entries.writeUInt8(0, entryOffset + 3); // reserved
  entries.writeUInt16LE(1, entryOffset + 4); // planes
  entries.writeUInt16LE(32, entryOffset + 6); // bpp
  entries.writeUInt32LE(frame.data.length, entryOffset + 8); // size
  entries.writeUInt32LE(currentOffset, entryOffset + 12); // offset

  currentOffset += frame.data.length;
  bodyParts.push(frame.data);
}

const icoBuffer = Buffer.concat([header, entries, ...bodyParts]);
writeFileSync(ICO_PATH, icoBuffer);

console.log(`✅ Flawless Windows DIB 32-bit ARGB + 1-bit AND-Mask ICO created: ${ICO_PATH} (${icoBuffer.length} bytes, ${count} frames)`);
