import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT_DIR, "src/data/gitMeta.json");

function resolveGitMeta() {
  const envSha = (
    process.env.COMMIT_REF ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.CF_PAGES_COMMIT_SHA ||
    ""
  ).trim();

  let commits = [];
  let currentSha = envSha ? envSha.slice(0, 7) : "";

  try {
    const output = execSync("git log -n 50 --format=%h", {
      cwd: ROOT_DIR,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    commits = output
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!currentSha && commits.length > 0) {
      currentSha = commits[0];
    }
  } catch {
    if (currentSha) commits = [currentSha];
  }

  return {
    currentSha,
    builtAt: new Date().toISOString(),
    commits,
  };
}

try {
  const meta = resolveGitMeta();
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  console.log(`[gitMeta] Generated git metadata: ${meta.currentSha || "unknown"} (${meta.commits.length} commits)`);
} catch (err) {
  console.warn("[gitMeta] Warning: Failed to generate git metadata:", err.message);
}
