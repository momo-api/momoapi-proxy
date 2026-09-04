import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

const token = execSync("gh auth token", { encoding: "utf8" }).trim();
const remoteUrl = `https://${token}@github.com/momo-api/momoapi-proxy.git`;

console.log("Pushing main branch and tags to GitHub...");
execSync(`git push "${remoteUrl}" main --tags -f`, { cwd: ROOT, stdio: "inherit" });
console.log("Push completed successfully!");
