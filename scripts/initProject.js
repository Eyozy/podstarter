import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import Parser from "rss-parser";
import { atomicWriteJson } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SITE_CONFIG_PATH = path.join(__dirname, "../src/data/site.json");
const EPISODES_PATH = path.join(__dirname, "../src/data/episodes.json");
const THEMES_PATH = path.join(__dirname, "../src/data/themes.json");

function readSiteConfig() {
  if (!fs.existsSync(SITE_CONFIG_PATH)) {
    throw new Error(`未找到站点配置文件：${SITE_CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(SITE_CONFIG_PATH, "utf-8"));
}

function writeJsonFile(filePath, data) {
  atomicWriteJson(filePath, data);
}

async function main() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\n请选择初始化方式:\n  [1] 全新自建独立播客（从零开始，不依赖任何平台）\n  [2] 从已有播客 RSS 导入（从小宇宙/喜马拉雅/苹果等克隆）");

    let choice = (await rl.question("请输入选项 [默认 1]: ")).trim();
    if (!choice) choice = "1";

    while (choice !== "1" && choice !== "2") {
      console.log("⚠️  无效选项，请输入 1 或 2。");
      choice = (await rl.question("请输入选项 [默认 1]: ")).trim();
      if (!choice) choice = "1";
    }

    const siteConfig = readSiteConfig();
    siteConfig.site = siteConfig.site || {};
    siteConfig.brand = siteConfig.brand || {};
    siteConfig.brand.meta = siteConfig.brand.meta || {};
    siteConfig.podcast = siteConfig.podcast || {};

    if (choice === "1") {
      console.log("\n--- 全新自建独立播客配置 ---");
      const brandName =
        (await rl.question("播客名称 (默认 \"我的播客\"): ")).trim() || "我的播客";
      const siteUrl =
        (await rl.question("站点网址 (默认 \"https://example.com\"): ")).trim() ||
        "https://example.com";
      const author =
        (await rl.question("主持人/创作者 (默认 \"主播\"): ")).trim() || "主播";
      const description = (await rl.question("播客简介：")).trim();

      siteConfig.site.url = siteUrl;
      siteConfig.brand.name = brandName;
      siteConfig.brand.meta.author = author;
      if (description) {
        siteConfig.brand.meta.description = description;
        siteConfig.brand.meta.ogDescription = description;
      }

      writeJsonFile(SITE_CONFIG_PATH, siteConfig);
      writeJsonFile(EPISODES_PATH, []);
      writeJsonFile(THEMES_PATH, []);

      console.log("\n✅ 初始化完成！你可以在 src/data/episodes.json 中添加单集，或在后台发布。\n");
    } else if (choice === "2") {
      console.log("\n--- 从已有播客 RSS 导入配置 ---");

      let rssUrl = "";
      while (!rssUrl) {
        rssUrl = (await rl.question("RSS 订阅地址 (必填): ")).trim();
        if (!rssUrl) {
          console.log("⚠️  RSS 订阅地址为必填项。");
        }
      }

      const brandName = (
        await rl.question("播客名称 (回车留空则从 RSS 自动识别): ")
      ).trim();

      let siteUrl = "";
      while (!siteUrl) {
        siteUrl = (await rl.question("站点网址 (必填): ")).trim();
        if (!siteUrl) {
          console.log("⚠️  站点网址为必填项。");
        }
      }

      siteConfig.site.url = siteUrl;
      siteConfig.podcast.rssUrl = rssUrl;

      if (brandName) {
        siteConfig.brand.name = brandName;
      } else {
        try {
          console.log("⏳ 正在尝试从 RSS 读取播客信息...");
          const parser = new Parser();
          const feed = await parser.parseURL(rssUrl);
          if (feed.title) {
            siteConfig.brand.name = feed.title.trim();
            console.log(`ℹ️  已从 RSS 自动识别播客名称：${siteConfig.brand.name}`);
          }
          if (feed.description && !siteConfig.brand.meta.description) {
            siteConfig.brand.meta.description = feed.description.trim();
            siteConfig.brand.meta.ogDescription = feed.description.trim();
          }
        } catch {
          console.log("⚠️  无法从 RSS 解析播客名称，保留原名称。");
        }
      }

      writeJsonFile(SITE_CONFIG_PATH, siteConfig);

      console.log("\n⏳ 正在从 RSS 同步节目内容 (node scripts/syncContent.js)...");
      const syncResult = spawnSync(
        process.execPath,
        [path.join(__dirname, "syncContent.js")],
        {
          stdio: "inherit",
          cwd: path.join(__dirname, ".."),
        }
      );

      if (syncResult.status !== 0) {
        console.error(`\n⚠️  RSS 同步执行失败 (退出代码：${syncResult.status})，你可以稍后运行 npm run sync 重试。`);
      } else {
        console.log("\n✅ 初始化完成！已从 RSS 成功同步内容。\n");
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("❌ 初始化向导异常退出：", err);
  process.exit(1);
});
