import "dotenv/config";
import Parser from "rss-parser";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import DOMPurify from "isomorphic-dompurify";
import { getRssUrl, loadSiteConfig, isAiEnabled } from "./site-config.js";
import {
  getProviderEnvPrefix,
  getSupportedProvidersText,
  normalizeProvider,
} from "./ai-provider-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RSS_URL = getRssUrl();
const DATA_PATH = path.join(__dirname, "../src/data/episodes.json");
const TRANSCRIPTS_DIR = path.join(__dirname, "../src/content/transcripts");
const THEMES_PATH = path.join(__dirname, "../src/data/themes.json");
const TAG_TAXONOMY_PATH = path.join(__dirname, "../src/data/tag-taxonomy.json");
const RSS_CACHE_PATH = path.join(__dirname, "../.last-rss-url");
const ENV_PATH = path.join(__dirname, "../.env");
const SITE_CONFIG = loadSiteConfig();
const TRANSCRIPT_PLACEHOLDER = SITE_CONFIG?.transcripts?.placeholderNotice;

if (!TRANSCRIPT_PLACEHOLDER) {
  throw new Error("Missing transcripts.placeholderNotice in site config.");
}

// ============ 中英文/数字自动加空格排版格式化 (autocorrect 兼容) ============
function autocorrect(text) {
  if (typeof text !== "string") return text;
  
  const placeholders = [];
  let index = 0;
  
  // 1. 保护 Markdown 代码块 (``` ... ```)
  let processed = text.replace(/(```[\s\S]*?```)/g, (match) => {
    const key = `___BLOCK_CODE_PLACEHOLDER_${index++}___`;
    placeholders.push({ key, val: match });
    return key;
  });
  
  // 2. 保护 Markdown 行内代码 (`...`)
  processed = processed.replace(/(`[^`\n]+`)/g, (match) => {
    const key = `___INLINE_CODE_PLACEHOLDER_${index++}___`;
    placeholders.push({ key, val: match });
    return key;
  });

  // 3. 保护 HTML 标签
  processed = processed.replace(/(<\/?[a-zA-Z0-9:-]+(?:\s+[^>]*)?>)/g, (match) => {
    const key = `___HTML_TAG_PLACEHOLDER_${index++}___`;
    placeholders.push({ key, val: match });
    return key;
  });

  // 4. 保护 Markdown 链接的 URL 部分
  processed = processed.replace(/(\]\((?:[^)]+)\))/g, (match) => {
    const key = `___MD_URL_PLACEHOLDER_${index++}___`;
    placeholders.push({ key, val: match });
    return key;
  });

  // 5. CJK 与 英文/数字 之间加空格
  const cjk = '[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff]';
  const alphaNum = '[a-zA-Z0-9]';

  processed = processed.replace(new RegExp(`(${cjk})(${alphaNum})`, 'g'), '$1 $2');
  processed = processed.replace(new RegExp(`(${alphaNum})(${cjk})`, 'g'), '$1 $2');

  // 6. 还原所有被保护的区块
  // 占位符 key 唯一，不会相互嵌套，一次遍历还原即可
  for (const { key, val } of placeholders) {
    processed = processed.split(key).join(val);
  }

  return processed;
}

function formatMarkdownFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  
  const match = content.match(/^---([\s\S]*?)---([\s\S]*)$/);
  if (!match) {
    const formatted = autocorrect(content);
    if (formatted !== content) {
      fs.writeFileSync(filePath, formatted, "utf-8");
    }
    return;
  }

  const frontmatter = match[1];
  const body = match[2];

  let formattedFrontmatter = frontmatter.replace(/^(title:\s*)(['"]?)(.*?)\2(\s*)$/m, (fmMatch, prefix, quote, val, suffix) => {
    return `${prefix}${quote}${autocorrect(val)}${quote}${suffix}`;
  });

  const formattedBody = autocorrect(body);

  const finalContent = `---${formattedFrontmatter}---${formattedBody}`;
  if (finalContent !== content) {
    fs.writeFileSync(filePath, finalContent, "utf-8");
  }
}

// ============ 环境变量检测 ============
function checkEnvStatus() {
  // 首先检查配置开关
  if (!isAiEnabled()) {
    console.log("ℹ️  AI 标签/主题功能未启用（features.aiTagging = false）");
    console.log("   如需启用，请在 site.json 中设置 features.aiTagging: true 并配置环境变量\n");
    return { hasEnv: false, hasApiKey: false, aiDisabled: true };
  }

  const envExists = fs.existsSync(ENV_PATH);

  const providerRaw = process.env.AI_PROVIDER;
  const provider = normalizeProvider(providerRaw) || "";

  if (!provider) {
    if (!envExists) {
      console.log("ℹ️  未检测到 .env 文件，跳过 AI 打标功能");
    } else {
      console.log("⚠️  .env 文件中未配置 AI_PROVIDER，跳过 AI 打标功能");
    }
    console.log(
      "   如需启用 AI 功能，请在 .env 或环境变量中配置：AI_PROVIDER + 对应的 *_API_KEY/_API_URL/_MODEL\n",
    );
    return { hasEnv: envExists, hasApiKey: false };
  }

  const prefix = getProviderEnvPrefix(provider);

  if (!prefix) {
    console.log(`⚠️  AI_PROVIDER=${providerRaw} 不受支持，跳过 AI 打标功能`);
    console.log(`   支持的取值：${getSupportedProvidersText()}\n`);
    return { hasEnv: envExists, hasApiKey: false };
  }

  const apiKeyEnv = `${prefix}_API_KEY`;
  const apiUrlEnv = `${prefix}_API_URL`;
  const modelEnv = `${prefix}_MODEL`;

  if (!process.env[apiKeyEnv]) {
    console.log(`⚠️  未配置 ${apiKeyEnv}，跳过 AI 打标功能`);
    console.log(`   请在 .env 或环境变量中添加：${apiKeyEnv}=你的密钥\n`);
    return { hasEnv: envExists, hasApiKey: false };
  }
  if (!process.env[apiUrlEnv]) {
    console.log(`⚠️  未配置 ${apiUrlEnv}，跳过 AI 打标功能`);
    console.log(`   请在 .env 或环境变量中添加：${apiUrlEnv}=请求地址\n`);
    return { hasEnv: envExists, hasApiKey: false };
  }
  if (!process.env[modelEnv]) {
    console.log(`⚠️  未配置 ${modelEnv}，跳过 AI 打标功能`);
    console.log(`   请在 .env 或环境变量中添加：${modelEnv}=模型名称\n`);
    return { hasEnv: envExists, hasApiKey: false };
  }

  return { hasEnv: envExists, hasApiKey: true };
}

// ============ RSS 变更检测 ============
function getLastRssUrl() {
  if (!fs.existsSync(RSS_CACHE_PATH)) {
    return null;
  }
  return fs.readFileSync(RSS_CACHE_PATH, "utf-8").trim();
}

function saveLastRssUrl(url) {
  fs.writeFileSync(RSS_CACHE_PATH, url);
}

function clearAllData() {
  // 清空 episodes.json
  if (fs.existsSync(DATA_PATH)) {
    fs.unlinkSync(DATA_PATH);
    console.log("   ✓ 已清空 episodes.json");
  }

  // 清空 themes.json
  if (fs.existsSync(THEMES_PATH)) {
    fs.unlinkSync(THEMES_PATH);
    console.log("   ✓ 已清空 themes.json");
  }

  // 清空 tag-taxonomy.json
  if (fs.existsSync(TAG_TAXONOMY_PATH)) {
    fs.unlinkSync(TAG_TAXONOMY_PATH);
    console.log("   ✓ 已清空 tag-taxonomy.json");
  }

  // 清空 transcripts 目录
  if (fs.existsSync(TRANSCRIPTS_DIR)) {
    const files = fs.readdirSync(TRANSCRIPTS_DIR);
    const mdFiles = files.filter((file) => file.endsWith(".md"));
    mdFiles.forEach((file) => {
      fs.unlinkSync(path.join(TRANSCRIPTS_DIR, file));
    });
    if (mdFiles.length > 0) {
      console.log(`   ✓ 已清空 ${mdFiles.length} 个文字稿文件`);
    }
  }
}

async function askUserConfirm(question, defaultOnNonTTY = true) {
  // CI 环境或非交互式终端，默认返回 defaultOnNonTTY
  if (!process.stdin.isTTY) {
    console.log(`${question} [非交互环境，默认选择：${defaultOnNonTTY ? "Y" : "N"}]`);
    return defaultOnNonTTY;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === "" || normalized === "y" || normalized === "yes");
    });
  });
}

async function checkRssChange() {
  const lastRssUrl = getLastRssUrl();
  const existingEpisodes = readEpisodes();
  const hasExistingData = existingEpisodes.length > 0;

  // 首次运行且没有旧数据，直接保存 RSS 地址
  if (!lastRssUrl && !hasExistingData) {
    saveLastRssUrl(RSS_URL);
    return;
  }

  // 首次运行但有旧数据（用户下载模板后的场景）
  if (!lastRssUrl && hasExistingData) {
    // 如果有旧数据，提示用户是否清空
    console.log("\n⚠️  检测到已有播客数据（可能来自模板示例）");
    console.log(`   当前数据：${existingEpisodes.length} 集节目`);
    console.log(`   新 RSS 地址：${RSS_URL}\n`);

    const confirm = await askUserConfirm("是否清空旧数据并重新同步？[Y/n] ", false);

    if (confirm) {
      console.log("\n正在清空旧数据...");
      clearAllData();
      console.log("");
    } else {
      console.log("\n保留旧数据，继续同步...\n");
    }

    saveLastRssUrl(RSS_URL);
    return;
  }

  // RSS 地址未变化
  if (lastRssUrl === RSS_URL) {
    return;
  }

  // RSS 地址变化，提示用户
  console.log("\n⚠️  检测到 RSS 地址已变更");
  console.log(`   旧地址：${lastRssUrl}`);
  console.log(`   新地址：${RSS_URL}\n`);

  const confirm = await askUserConfirm("是否清空旧数据并重新同步？[Y/n] ", false);

  if (confirm) {
    console.log("\n正在清空旧数据...");
    clearAllData();
    console.log("");
  } else {
    console.log("\n保留旧数据，继续同步...\n");
  }

  saveLastRssUrl(RSS_URL);
}


function parseArgs(args) {
  const parsed = {
    skipTag: false,
    skipTranscripts: false,
  };

  args.forEach((arg) => {
    if (arg === "--skip-tag") parsed.skipTag = true;
    if (arg === "--skip-transcripts") parsed.skipTranscripts = true;
  });

  return parsed;
}

const options = parseArgs(process.argv.slice(2));

function readEpisodes() {
  if (!fs.existsSync(DATA_PATH)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
  } catch (e) {
    console.warn("⚠️  episodes.json 解析失败，将视为空数据：", e.message);
    return [];
  }
}

function writeEpisodes(episodes) {
  const tempPath = DATA_PATH + ".tmp";
  fs.writeFileSync(tempPath, JSON.stringify(episodes, null, 2));
  fs.renameSync(tempPath, DATA_PATH);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function extractEpisodeId(item, index) {
  const linkMatch = item.link?.match(/\/episode\/([a-z0-9]+)/i);
  if (linkMatch) return linkMatch[1];
  const guidMatch = item.guid?.match(/\/([a-f0-9]+)$/i);
  if (guidMatch) return guidMatch[1];
  return `ep-${index}`;
}

function normalizeEpisode(item, index) {
  // 使用 DOMPurify 清理 RSS content，防止 XSS 攻击
  const sanitizedContent = item.content
    ? DOMPurify.sanitize(item.content, {
        ALLOWED_TAGS: ['p', 'br', 'b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li'],
        ALLOWED_ATTR: ['href', 'target', 'rel'],
      })
    : "";

  return {
    id: extractEpisodeId(item, index),
    title: autocorrect(item.title || ""),
    link: item.link || "",
    pubDate: item.pubDate || "",
    content: autocorrect(sanitizedContent),
    contentSnippet: autocorrect(item.contentSnippet || ""),
    enclosure: item.enclosure,
    itunes: item.itunes || {},
  };
}

function mergeEpisode(incoming, existing) {
  return {
    id: incoming.id,
    title: incoming.title || existing?.title || "",
    link: incoming.link || existing?.link || "",
    pubDate: incoming.pubDate || existing?.pubDate || "",
    content: incoming.content || existing?.content || "",
    contentSnippet: incoming.contentSnippet || existing?.contentSnippet || "",
    enclosure: incoming.enclosure || existing?.enclosure,
    itunes: { ...(existing?.itunes || {}), ...(incoming.itunes || {}) },
    themeId: existing?.themeId,
    tags: Array.isArray(existing?.tags) ? existing.tags : [],
  };
}

function buildCompareFields(episode) {
  return {
    title: episode.title || "",
    link: episode.link || "",
    pubDate: episode.pubDate || "",
    content: episode.content || "",
    contentSnippet: episode.contentSnippet || "",
    enclosureUrl: episode.enclosure?.url || "",
    enclosureType: episode.enclosure?.type || "",
    itunesEpisode: episode.itunes?.episode || "",
    itunesDuration: episode.itunes?.duration || "",
    itunesImage: episode.itunes?.image || "",
  };
}

function isEpisodeChanged(existing, merged) {
  return (
    JSON.stringify(buildCompareFields(existing)) !==
    JSON.stringify(buildCompareFields(merged))
  );
}

function escapeYaml(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function buildTranscriptTemplate(episode) {
  return `---\ntitle: "${escapeYaml(episode.title)}"\ncontributors: []\n---\n\n> ${TRANSCRIPT_PLACEHOLDER}\n`;
}

function ensureTranscriptFiles(episodesById, ids) {
  if (ids.length === 0) return 0;
  ensureDir(TRANSCRIPTS_DIR);
  let createdCount = 0;

  ids.forEach((id) => {
    const episode = episodesById.get(id);
    if (!episode) return;
    const transcriptPath = path.join(TRANSCRIPTS_DIR, `${id}.md`);
    if (fs.existsSync(transcriptPath)) return;
    fs.writeFileSync(transcriptPath, buildTranscriptTemplate(episode));
    createdCount += 1;
  });

  return createdCount;
}

function runAnalyzeThemes() {
  // sync 是“自动流程入口”：
  // 当 themes.json 不存在时，这里自动调用 analyze-themes.js 先生成主题分类体系，
  // 然后下面的 runTagging() 再基于 themes.json 给节目写入 themeId / tags。
  console.log("正在分析主题并生成 themes.json...");
  const analyzeScript = path.join(__dirname, "analyze-themes.js");
  const result = spawnSync(process.execPath, [analyzeScript], { stdio: "inherit" });
  return result.status === 0;
}

function runTagging(ids, envStatus) {
  if (options.skipTag) {
    console.log("跳过 AI 打标：--skip-tag 已启用");
    return;
  }
  if (!envStatus.hasApiKey) {
    // 环境变量检测已在前面输出过提示，这里静默跳过
    return;
  }
  if (ids.length === 0) {
    console.log("跳过 AI 打标：没有需要更新的节目");
    return;
  }

  // 检查 themes.json 是否存在，不存在则先生成
  if (!fs.existsSync(THEMES_PATH)) {
    console.log("未检测到 themes.json，需要先分析主题...\n");
    const success = runAnalyzeThemes();
    if (!success) {
      console.log("⚠️  主题分析失败，跳过 AI 打标");
      return;
    }
    console.log("");
  }

  // 检查 tag-taxonomy.json 是否存在
  if (!fs.existsSync(TAG_TAXONOMY_PATH)) {
    console.log("⚠️  未检测到 tag-taxonomy.json，跳过 AI 打标");
    console.log("   请确保 src/data/tag-taxonomy.json 文件存在\n");
    return;
  }

  console.log("正在执行 AI 打标...");
  const tagScript = path.join(__dirname, "tag-episodes.js");
  const args = [tagScript, "--ids", ids.join(",")];
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function syncContent() {
  // 检查是否开启了 AI 打标功能
  const aiEnabled = isAiEnabled();
  
  if (!aiEnabled) {
    if (fs.existsSync(THEMES_PATH)) {
      fs.unlinkSync(THEMES_PATH);
      console.log("   ✓ AI 功能已关闭，清理历史 themes.json");
    }
    if (fs.existsSync(TAG_TAXONOMY_PATH)) {
      fs.unlinkSync(TAG_TAXONOMY_PATH);
      console.log("   ✓ AI 功能已关闭，清理历史 tag-taxonomy.json");
    }
  }

  // 检测环境变量状态
  const envStatus = checkEnvStatus();

  // 检测 RSS 地址是否变更
  await checkRssChange();

  const parser = new Parser();
  const existingEpisodes = readEpisodes();
  const existingById = new Map(existingEpisodes.map((ep) => [ep.id, ep]));

  console.log("Fetching RSS feed...");
  const feed = await parser.parseURL(RSS_URL);

  const incomingEpisodes = feed.items.map((item, index) =>
    normalizeEpisode(item, index),
  );

  const mergedEpisodes = [];
  const updatedIds = [];
  const newIds = [];
  const incomingIds = new Set();

  incomingEpisodes.forEach((incoming) => {
    incomingIds.add(incoming.id);
    const existing = existingById.get(incoming.id);
    const merged = mergeEpisode(incoming, existing);
    mergedEpisodes.push(merged);

    if (!existing) {
      newIds.push(incoming.id);
      updatedIds.push(incoming.id);
    } else if (isEpisodeChanged(existing, merged)) {
      updatedIds.push(incoming.id);
    }
  });

  // Preserve episodes that may no longer appear in feed to avoid data loss
  const orphaned = existingEpisodes.filter((ep) => !incomingIds.has(ep.id));
  if (orphaned.length) {
    mergedEpisodes.push(...orphaned);
  }

  writeEpisodes(mergedEpisodes);

  const episodesById = new Map(mergedEpisodes.map((ep) => [ep.id, ep]));
  let transcriptCount = 0;
  if (!options.skipTranscripts) {
    transcriptCount = ensureTranscriptFiles(episodesById, updatedIds);
  } else {
    console.log("Skip transcripts: --skip-transcripts enabled.");
  }

  // 格式化所有的 markdown 文字稿文件，确保排版完美匹配 VSCode autocorrect 插件
  if (fs.existsSync(TRANSCRIPTS_DIR)) {
    console.log("正在对所有的播客文稿进行中英文排版自动优化...");
    const files = fs.readdirSync(TRANSCRIPTS_DIR);
    let formattedCount = 0;
    files.forEach((file) => {
      if (file.endsWith(".md") && !file.startsWith("_")) {
        formatMarkdownFile(path.join(TRANSCRIPTS_DIR, file));
        formattedCount++;
      }
    });
    console.log(`✓ 成功格式化了 ${formattedCount} 个文稿文件！`);
  }

  // 生成文字稿目录索引，方便在 VS Code 中快速查找对应文件
  generateTranscriptIndex(mergedEpisodes);

  console.log(`Episodes fetched: ${incomingEpisodes.length}`);
  console.log(`New episodes: ${newIds.length}`);
  console.log(`Updated episodes: ${updatedIds.length - newIds.length}`);
  console.log(`Transcript templates created: ${transcriptCount}`);

  runTagging(updatedIds, envStatus);
}

// ============ 文字稿目录索引生成 ============
function generateTranscriptIndex(episodes) {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) return;

  // 按发布日期从旧到新排序（第 001 期是最早的）
  const sorted = [...episodes]
    .filter((ep) => ep.pubDate)
    .sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));

  const rows = sorted.map((ep, i) => {
    const num = String(i + 1).padStart(3, "0");
    const title = (ep.title || "(无标题)").replace(/\|/g, "｜"); // 转义表格竖线
    const filename = `${ep.id}.md`;
    const filePath = path.join(TRANSCRIPTS_DIR, filename);

    let status;
    if (!fs.existsSync(filePath)) {
      status = "🔴 缺失";
    } else {
      const fileContent = fs.readFileSync(filePath, "utf-8");
      // 仅当包含系统配置的占位通知文本时，才判定为“待补充”
      const isPlaceholder = fileContent.includes(TRANSCRIPT_PLACEHOLDER);
      status = isPlaceholder ? "🟡 待补充" : "🟢 完整";
    }

    // 节目标题直接作为超链接，点击跳转对应文稿
    return `| ${num} | [${title}](./${filename}) | ${status} |`;
  });

  const totalComplete = rows.filter((r) => r.includes("🟢 完整")).length;
  const totalPlaceholder = rows.filter((r) => r.includes("🟡 待补充")).length;
  const totalMissing = rows.filter((r) => r.includes("🔴 缺失")).length;

  // 只保留日期格式 (YYYY-MM-DD)
  const now = new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).replace(/\//g, "-");

  const indexPath = path.join(TRANSCRIPTS_DIR, "_index.md");
  let oldDate = now;
  let oldContentWithoutDate = "";

  if (fs.existsSync(indexPath)) {
    const oldFileContent = fs.readFileSync(indexPath, "utf-8");
    const dateMatch = oldFileContent.match(/> 📅 \*\*最后更新时间\*\*：([^\n]+)/);
    if (dateMatch) {
      oldDate = dateMatch[1];
    }
    oldContentWithoutDate = oldFileContent.replace(/> 📅 \*\*最后更新时间\*\*：[^\n]+\n/, "");
  }

  const generateContent = (dateStr) => [
    `---`,
    `title: "文字稿目录索引（自动生成）"`,
    `contributors: []`,
    `---`,
    ``,
    `# 文字稿目录索引`,
    ``,
    `> 💡 **自动更新提示**：此文件由 \`sync-content.js\` 自动生成，请勿手动编辑。`,
    `> 📅 **最后更新时间**：${dateStr}`,
    `> 📊 **统计数据**：共 **${sorted.length}** 期节目 | 🟢 完整 **${totalComplete}** 期 | 🟡 待补充 **${totalPlaceholder}** 期` + (totalMissing > 0 ? ` | 🔴 缺失 **${totalMissing}** 期` : ""),
    ``,
    `提示：在支持 Markdown 预览或链接跳转的编辑器（如 VS Code）中，按住 \`Ctrl\`（Mac 用户按住 \`Cmd\` ⌘）点击下表中的**节目标题**，即可直接打开并编辑对应的文字稿文件。`,
    ``,
    `| 序号 | 节目标题 | 文字稿状态 |`,
    `|------|----------|------------|`,
    ...rows,
  ].join("\n");

  const newContentWithoutDate = generateContent(oldDate).replace(/> 📅 \*\*最后更新时间\*\*：[^\n]+\n/, "");

  if (oldContentWithoutDate === newContentWithoutDate && fs.existsSync(indexPath)) {
    console.log(`✓ 文字稿目录索引无变化，跳过更新`);
    return;
  }

  const indexContent = generateContent(now);
  fs.writeFileSync(indexPath, indexContent, "utf-8");
  console.log(`✓ 已生成文字稿目录索引 → _index.md（${sorted.length} 期）`);
}

syncContent().catch((error) => {
  console.error("Failed to sync content:", error);
  process.exit(1);
});
