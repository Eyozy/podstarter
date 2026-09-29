import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, askUserConfirm } from "./utils.js";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);

const DATA_PATH = path.join(scriptDir, "../src/data/episodes.json");
const THEMES_PATH = path.join(scriptDir, "../src/data/themes.json");
const TRANSCRIPTS_DIR = path.join(scriptDir, "../src/content/transcripts");
const RSS_CACHE_PATH = path.join(scriptDir, "../.last-rss-url");
const TAG_TAXONOMY_PATH = path.join(scriptDir, "../src/data/tag-taxonomy.json");
const SITE_CONFIG_PATH = path.join(scriptDir, "../src/data/site.json");

export function resetData() {
  let count = 0;
  const dataDir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  atomicWriteJson(DATA_PATH, []);
  console.log("   ✓ 已重置 episodes.json 为 []");
  count++;
  const themesDir = path.dirname(THEMES_PATH);
  if (!fs.existsSync(themesDir)) {
    fs.mkdirSync(themesDir, { recursive: true });
  }
  atomicWriteJson(THEMES_PATH, []);
  console.log("   ✓ 已重置 themes.json 为 []");
  if (fs.existsSync(TAG_TAXONOMY_PATH)) {
    fs.unlinkSync(TAG_TAXONOMY_PATH);
    console.log("   ✓ 已删除 tag-taxonomy.json");
    count++;
  }
  if (fs.existsSync(SITE_CONFIG_PATH)) {
    atomicWriteJson(SITE_CONFIG_PATH, {});
    console.log("   ✓ 已重置 site.json 为 {}（恢复默认模板配置）");
    count++;
  }
  count++;
  if (fs.existsSync(RSS_CACHE_PATH)) {
    fs.unlinkSync(RSS_CACHE_PATH);
    console.log("   ✓ 已删除 RSS 地址缓存");
    count++;
  }
  if (!fs.existsSync(TRANSCRIPTS_DIR)) {
    fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  }

  const files = fs.readdirSync(TRANSCRIPTS_DIR);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  mdFiles.forEach((file) => {
    fs.unlinkSync(path.join(TRANSCRIPTS_DIR, file));
  });
  if (mdFiles.length > 0) {
    console.log(`   ✓ 已删除 ${mdFiles.length} 个文字稿文件`);
    count += mdFiles.length;
  }
  const remainingFiles = fs.readdirSync(TRANSCRIPTS_DIR);
  const nonGitkeepFiles = remainingFiles.filter((f) => f !== ".gitkeep");
  if (nonGitkeepFiles.length === 0) {
    const gitkeepPath = path.join(TRANSCRIPTS_DIR, ".gitkeep");
    if (!fs.existsSync(gitkeepPath)) {
      fs.writeFileSync(gitkeepPath, "", "utf-8");
      console.log("   ✓ 已创建 transcripts/.gitkeep 保留目录");
    }
  }

  return count;
}

async function main() {
  console.log("\n⚠️  此操作将重置/清空以下数据：");
  console.log("   - src/data/episodes.json（重置为空数组 []）");
  console.log("   - src/data/themes.json（重置为空数组 []）");
  console.log("   - src/content/transcripts/*.md（清空文字稿文件）");
  console.log("   - src/data/site.json（重置为 {} 恢复默认模板配置）");
  console.log("   - .last-rss-url（删除 RSS 地址缓存）\n");

  const autoConfirm = process.argv.includes("-y") || process.argv.includes("--yes");
  const confirm = autoConfirm || (await askUserConfirm("确定要重置所有播客数据吗？[Y/n] "));

  if (!confirm) {
    console.log("\n已取消操作。\n");
    process.exit(0);
  }

  console.log("\n正在重置数据...");
  const count = resetData();

  if (count > 0) {
    console.log(`\n✅ 重置完成！已重置数据文件并清理相关缓存。\n`);
    console.log("   现在可以运行 npm run sync 同步新的播客内容。\n");
  } else {
    console.log("\nℹ️  没有需要清理的数据。\n");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  main().catch((error) => {
    console.error("重置失败：", error);
    process.exit(1);
  });
}
