import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const DIST = join(ROOT, "dist");
const ICO_PATH = join(ROOT, "app.ico");

mkdirSync(DIST, { recursive: true });

console.log("=== 1. Bundling momoapi-proxy with esbuild ===");
const bundlePath = join(DIST, "bundle.cjs");
execSync(`npx --yes esbuild bin/momoapi-proxy.mjs --bundle --platform=node --format=cjs --banner:js="const import_meta_url = require('url').pathToFileURL(__filename).href;" --define:import.meta.url=import_meta_url --outfile="${bundlePath}"`, {
  cwd: ROOT,
  stdio: "inherit",
});

console.log("=== 2. Generating SEA blob ===");
const seaConfigPath = join(DIST, "sea-config.json");
const blobPath = join(DIST, "sea-prep.blob");
writeFileSync(seaConfigPath, JSON.stringify({
  main: bundlePath,
  output: blobPath,
  disableExperimentalSEAWarning: true,
}, null, 2));

execSync(`node --experimental-sea-config "${seaConfigPath}"`, {
  cwd: ROOT,
  stdio: "inherit",
});

console.log("=== 3. Copying node runtime binary ===");
const nodeExe = process.execPath;
const exeOutput = join(DIST, "momoapi-proxy-windows-x64.exe");
copyFileSync(nodeExe, exeOutput);

console.log("=== 4. Injecting SEA blob with postject ===");
execSync(`npx --yes postject "${exeOutput}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`, {
  cwd: ROOT,
  stdio: "inherit",
});

if (existsSync(ICO_PATH)) {
  console.log("=== 5. Injecting HD Application Icon & Metadata with resedit ===");
  try {
    execSync(`npx --yes resedit-cli --in "${exeOutput}" --out "${exeOutput}" --ignore-signed --icon "1,${ICO_PATH}" --product-name "MOMO API Proxy" --file-description "MOMO API Proxy for Codex & Desktop AI" --company-name "MOMO API" --file-version "0.8.9.0" --product-version "0.8.9.0" --original-filename "momoapi-proxy-windows-x64.exe"`, {
      cwd: ROOT,
      stdio: "inherit",
    });
    console.log("✅ HD Icon & Windows Metadata successfully injected!");
  } catch (err) {
    console.warn("⚠️ Icon injection failed:", err.message);
  }
}

console.log(`\n🎉 Final Executable Built: ${exeOutput}`);
console.log("=== 6. Testing generated binary ===");
const out = execFileSync(exeOutput, ["--help"], { encoding: "utf8" });
console.log(out);
