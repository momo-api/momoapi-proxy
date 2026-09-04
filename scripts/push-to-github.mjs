import { execSync } from "node:child_process";

const token = execSync("gh auth token", { encoding: "utf8" }).trim();
const remoteUrl = `https://${token}@github.com/momo-api/momoapi-proxy.git`;

console.log("Pushing main branch and tags to GitHub...");
execSync(`git push "${remoteUrl}" main --tags -f`, { stdio: "inherit" });
console.log("Push completed successfully!");
