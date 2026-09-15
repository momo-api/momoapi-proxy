#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateUpdateArchive } from "../src/updater.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(SCRIPT_DIR);
const RELEASE_ROOT = "momoapi-proxy";

function parseArgs(args) {
  const options = { outputDir: join(ROOT_DIR, "dist", "release"), json: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--output-dir") {
      const next = args[index + 1];
      if (!next) throw new Error("--output-dir requires a path.");
      options.outputDir = isAbsolute(next) ? next : resolve(process.cwd(), next);
      index += 1;
      continue;
    }
    throw new Error("Unknown argument: " + value);
  }
  return options;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Could not locate the npm CLI used to build the release package.");
  return found;
}

export function buildReleasePackage({ outputDir = join(ROOT_DIR, "dist", "release") } = {}) {
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version || "")) {
    throw new Error("package.json contains an invalid release version.");
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "momoapi-proxy-release-"));
  try {
    const npmPackDir = join(temporaryRoot, "npm-pack");
    const extractedDir = join(temporaryRoot, "extracted");
    mkdirSync(npmPackDir);
    mkdirSync(extractedDir);

    const packedOutput = run(process.execPath, [
      npmCliPath(),
      "pack",
      "--ignore-scripts",
      "--silent",
      "--pack-destination",
      npmPackDir,
    ], { cwd: ROOT_DIR }).trim().split(/\r?\n/).filter(Boolean);
    const packedName = packedOutput.at(-1);
    if (!packedName) throw new Error("npm pack did not produce an archive.");

    const npmArchive = join(npmPackDir, basename(packedName));
    if (!existsSync(npmArchive)) throw new Error("npm pack output archive was not found.");
    run("tar", ["-xzf", npmArchive, "-C", extractedDir]);

    const npmRoot = join(extractedDir, "package");
    const releaseRoot = join(extractedDir, RELEASE_ROOT);
    if (!existsSync(npmRoot)) throw new Error("npm pack archive did not contain the expected package root.");
    renameSync(npmRoot, releaseRoot);

    mkdirSync(outputDir, { recursive: true });
    const archive = join(outputDir, "momoapi-proxy-" + pkg.version + ".tgz");
    const checksumFile = archive + ".sha256";
    rmSync(archive, { force: true });
    rmSync(checksumFile, { force: true });
    run("tar", ["-czf", archive, "-C", extractedDir, RELEASE_ROOT]);

    const admission = validateUpdateArchive(archive);
    const validationDir = join(temporaryRoot, "validation");
    mkdirSync(validationDir);
    run("tar", ["-xzf", archive, "-C", validationDir]);
    const finalRoot = join(validationDir, RELEASE_ROOT);
    const packaged = JSON.parse(readFileSync(join(finalRoot, "package.json"), "utf8"));
    if (packaged.version !== pkg.version) throw new Error("Release archive version does not match package.json.");
    for (const requiredPath of ["bin/momoapi-proxy.mjs", "src/update-supervisor.mjs"]) {
      if (!existsSync(join(finalRoot, ...requiredPath.split("/")))) {
        throw new Error("Release archive is missing updater-required file: " + requiredPath);
      }
    }

    const bytes = readFileSync(archive);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(checksumFile, sha256 + "  " + basename(archive) + "\n", "utf8");
    return {
      version: pkg.version,
      archive,
      checksumFile,
      sha256,
      bytes: bytes.length,
      entries: admission.entries,
      expandedBytes: admission.expandedBytes,
      root: RELEASE_ROOT + "/",
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = buildReleasePackage(options);
  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    "Built " + result.archive + "\nSHA-256: " + result.sha256 + "\n" +
    "Validated " + result.entries + " entries under " + result.root +
    " (" + result.expandedBytes + " expanded bytes).\n",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
