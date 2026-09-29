import "dotenv/config";
import Parser from "rss-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import DOMPurify from "isomorphic-dompurify";
import { atomicWriteJson, askUserConfirm } from "./utils.js";
import {
  getRssUrl,
  loadSiteConfig,
  isAiEnabled,
  isTranscriptEnabled,
  normalizeSiteUrl,
} from "./siteConfig.js";
import {
  getProviderEnvPrefix,
  getSupportedProvidersText,
  normalizeProvider,
} from "./aiProviderConfig.js";
import { resolvePodcastInput } from "../src/utils/resolver.ts";
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
const TRANSCRIPTS_ENABLED = isTranscriptEnabled();
const TRANSCRIPT_PLACEHOLDER = SITE_CONFIG?.transcripts?.placeholderNotice || "文字稿整理中...";
const PUBLIC_DIR = path.join(__dirname, "../public");
const ROBOTS_PATH = path.join(PUBLIC_DIR, "robots.txt");
if (!SITE_CONFIG?.site?.url) {
  throw new Error("Missing site.url in site config.");
}
function buildRobotsTxt(siteUrl) {
  const normalizedSiteUrl = normalizeSiteUrl(siteUrl);
  return `User-agent: *\nAllow: /\n\nSitemap: ${normalizedSiteUrl}/sitemap-index.xml\n`;
}


function archiveMissingEpisodes(existingEpisodes, incomingIds) {
  if (!Array.isArray(existingEpisodes) || existingEpisodes.length === 0) {
    return [];
  }

  return existingEpisodes
    .filter((episode) => !incomingIds.has(episode.id))
    .map((episode) => ({
      ...episode,
      archived: true,
    }));
}

function autocorrect(text) {
  if (typeof text !== "string") return text;
  
  const placeholders = [];
  let index = 0;
  
  let processed = text.replace(/(```[\s\S]*?```)/g, (match) => {
    const key = `___BLOCK_CODE_PLACEHOLDER_${index++}___`;
    placeholders.push({ key, val: match });
    return key;
  });
  
  processed = processed.replace(/(`[^`\n]+`)/g, (match) => {
    const key = `___INLINE_CODE_PLACEHOLDER_${index++}___`;
    placeholders.push({ key, val: match });
    return key;
  });

  processed = processed.replace(/(<\/?[a-zA-Z0-9:-]+(?:\s+[^>]*)?>)/g, (match) => {
    const key = `___HTML_TAG_PLACEHOLDER_${index++}___`;
    placeholders.push({ key, val: match });
    return key;
  });

  processed = processed.replace(/(\]\((?:[^)]+)\))/g, (match) => {
    const key = `___MD_URL_PLACEHOLDER_${index++}___`;
    placeholders.push({ key, val: match });
    return key;
  });

  const cjk = '[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff]';
  const alphaNum = '[a-zA-Z0-9]';

  processed = processed.replace(new RegExp(`(${cjk})(${alphaNum})`, 'g'), '$1 $2');
  processed = processed.replace(new RegExp(`(${alphaNum})(${cjk})`, 'g'), '$1 $2');

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

  let formattedFrontmatter = frontmatter.replace(/^(title:\s*)(['"]?)(.*?)\2(\s*)$/m, (_match, prefix, quote, val, suffix) => {
    return `${prefix}${quote}${autocorrect(val)}${quote}${suffix}`;
  });

  const formattedBody = autocorrect(body);

  const finalContent = `---${formattedFrontmatter}---${formattedBody}`;
  if (finalContent !== content) {
    fs.writeFileSync(filePath, finalContent, "utf-8");
  }
}

function checkEnvStatus() {
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
  atomicWriteJson(DATA_PATH, []);
  console.log("   ✓ 已重置 episodes.json 为 []");
  atomicWriteJson(THEMES_PATH, []);
  console.log("   ✓ 已重置 themes.json 为 []");
  if (fs.existsSync(TAG_TAXONOMY_PATH)) {
    fs.unlinkSync(TAG_TAXONOMY_PATH);
    console.log("   ✓ 已删除 tag-taxonomy.json");
  }
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

async function checkRssChange() {
  const lastRssUrl = getLastRssUrl();
  const existingEpisodes = readEpisodes();
  const hasExistingData = existingEpisodes.length > 0;

  if (!lastRssUrl && !hasExistingData) {
    saveLastRssUrl(RSS_URL);
    return;
  }

  if (!lastRssUrl && hasExistingData) {
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

  if (lastRssUrl === RSS_URL) {
    return;
  }

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
  atomicWriteJson(DATA_PATH, episodes);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function syncPublicMetadata() {
  ensureDir(PUBLIC_DIR);

  fs.writeFileSync(
    ROBOTS_PATH,
    buildRobotsTxt(SITE_CONFIG.site.url),
    "utf-8",
  );
}

function extractEpisodeId(item, index) {
  const xyzMatch = item.link?.match(/\/episode\/([a-z0-9]+)/i);
  if (xyzMatch) return xyzMatch[1];
  const neteaseMatch = item.link?.match(/[?&]id=(\d+)/i) || item.guid?.match(/[?&]id=(\d+)/i);
  if (neteaseMatch) return `netease-${neteaseMatch[1]}`;
  const xmMatch = item.link?.match(/\/sound\/(\d+)/i) || item.guid?.match(/\/sound\/(\d+)/i);
  if (xmMatch) return `xm-${xmMatch[1]}`;
  const guidMatch = item.guid?.match(/\/([a-f0-9]+)$/i);
  if (guidMatch) return guidMatch[1];
  return `ep-${index}`;
}

function normalizeEpisode(item, index) {
  const sanitizedContent = item.content
    ? DOMPurify.sanitize(item.content, {
        ALLOWED_TAGS: ['p', 'br', 'b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li'],
        ALLOWED_ATTR: ['href', 'target', 'rel'],
      })
    : "";
  const episodeContent = String(sanitizedContent || "");

  return {
    id: extractEpisodeId(item, index),
    title: autocorrect(item.title || ""),
    link: item.link || "",
    pubDate: item.pubDate || "",
    content: episodeContent,
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
    content: incoming.content,
    contentSnippet: incoming.contentSnippet,
    enclosure: incoming.enclosure || existing?.enclosure,
    itunes: { ...(existing?.itunes || {}), ...(incoming.itunes || {}) },
    archived: false,
    themeId: existing?.themeId || "",
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
  console.log("正在分析主题并生成 themes.json...");
  const analyzeScript = path.join(__dirname, "analyzeThemes.js");
  const result = spawnSync(process.execPath, [analyzeScript], { stdio: "inherit" });
  return result.status === 0;
}

function runTagging(ids, envStatus) {
  if (options.skipTag) {
    console.log("跳过 AI 打标：--skip-tag 已启用");
    return;
  }
  if (!envStatus.hasApiKey) {
    return;
  }
  if (ids.length === 0) {
    console.log("跳过 AI 打标：没有需要更新的节目");
    return;
  }

  if (!fs.existsSync(THEMES_PATH)) {
    console.log("未检测到 themes.json，需要先分析主题...\n");
    const success = runAnalyzeThemes();
    if (!success) {
      console.log("⚠️  主题分析失败，跳过 AI 打标");
      return;
    }
    console.log("");
  }

  if (!fs.existsSync(TAG_TAXONOMY_PATH)) {
    console.log("⚠️  未检测到 tag-taxonomy.json，跳过 AI 打标");
    console.log("   请确保 src/data/tag-taxonomy.json 文件存在\n");
    return;
  }

  console.log("正在执行 AI 打标...");
  const tagScript = path.join(__dirname, "tagEpisodes.js");
  const args = [tagScript, "--ids", ids.join(",")];
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function syncContent() {
  const aiEnabled = isAiEnabled();
  
  if (!aiEnabled) {
    if (fs.existsSync(THEMES_PATH)) {
      fs.writeFileSync(THEMES_PATH, "[]\n", "utf-8");
      console.log("   ✓ AI 功能已关闭，清空历史 themes.json");
    }
    if (fs.existsSync(TAG_TAXONOMY_PATH)) {
      fs.unlinkSync(TAG_TAXONOMY_PATH);
      console.log("   ✓ AI 功能已关闭，清理历史 tag-taxonomy.json");
    }
  }

  const envStatus = checkEnvStatus();

  await checkRssChange();

  const resolved = await resolvePodcastInput(RSS_URL);
  const existingEpisodes = readEpisodes();
  const existingById = new Map(existingEpisodes.map((ep) => [ep.id, ep]));

  let incomingEpisodes = [];
  if (resolved.type === "netease" || resolved.type === "direct") {
    incomingEpisodes = (resolved.episodes || []).map((ep) => ({
      ...ep,
      title: autocorrect(ep.title || ""),
      contentSnippet: autocorrect(ep.contentSnippet || ""),
    }));
  } else {
    const feedUrl = resolved.feedUrl || RSS_URL;
    const parser = new Parser({
      requestOptions: {
        headers: resolved.headers || {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      },
    });
    console.log(`Fetching feed (${resolved.platform}) from ${feedUrl}...`);
    const feed = await parser.parseURL(feedUrl);
    incomingEpisodes = feed.items.map((item, index) =>
      normalizeEpisode(item, index),
    );
  }
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

  const orphaned = archiveMissingEpisodes(existingEpisodes, incomingIds);
  if (orphaned.length) {
    mergedEpisodes.push(...orphaned);
  }

  writeEpisodes(mergedEpisodes);

  const episodesById = new Map(mergedEpisodes.map((ep) => [ep.id, ep]));
  let transcriptCount = 0;
  if (!TRANSCRIPTS_ENABLED) {
    console.log("Skip transcripts: features.transcripts = false.");
  } else if (!options.skipTranscripts) {
    transcriptCount = ensureTranscriptFiles(episodesById, updatedIds);
  } else {
    console.log("Skip transcripts: --skip-transcripts enabled.");
  }

  if (TRANSCRIPTS_ENABLED && fs.existsSync(TRANSCRIPTS_DIR)) {
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

  syncPublicMetadata();

  console.log(`Episodes fetched: ${incomingEpisodes.length}`);
  console.log(`New episodes: ${newIds.length}`);
  console.log(`Updated episodes: ${updatedIds.length - newIds.length}`);
  console.log(`Transcript templates created: ${transcriptCount}`);

  runTagging(updatedIds, envStatus);
}


syncContent().catch((error) => {
  console.error("Failed to sync content:", error);
  process.exit(1);
});
