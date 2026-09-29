import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { askAI } from "./aiClient.js";
import { isAiEnabled, loadSiteConfig } from "./siteConfig.js";
import { normalizeTags, fillTags, atomicWriteJson } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "../src/data");
const EPISODES_PATH = path.join(DATA_DIR, "episodes.json");
const THEMES_PATH = path.join(DATA_DIR, "themes.json");
const TAG_TAXONOMY_PATH = path.join(DATA_DIR, "tag-taxonomy.json");

const DEFAULT_LIMIT = Infinity;
const DEFAULT_CONCURRENCY = 5;
const MAX_CONTENT_CHARS = 800;

const { limit, ids, concurrency } = parseArgs(process.argv.slice(2));

function parseArgs(args) {
  const parsed = {
    limit: DEFAULT_LIMIT,
    concurrency: DEFAULT_CONCURRENCY,
    ids: [],
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--all") {
      parsed.limit = Infinity;
      continue;
    }
    if (arg === "--limit" && args[i + 1]) {
      parsed.limit = parseInt(args[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg === "--concurrency" && args[i + 1]) {
      parsed.concurrency = Math.max(1, parseInt(args[i + 1], 10) || DEFAULT_CONCURRENCY);
      i += 1;
      continue;
    }
    if (arg === "--ids" && args[i + 1]) {
      parsed.ids = args[i + 1]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (/^\d+$/.test(arg)) {
      parsed.limit = parseInt(arg, 10);
    }
  }

  return parsed;
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`${label} file not found: ${filePath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function writeEpisodes(episodes) {
  atomicWriteJson(EPISODES_PATH, episodes);
}

function truncateContent(content) {
  if (!content) return "";
  if (content.length <= MAX_CONTENT_CHARS) return content;
  return `${content.substring(0, MAX_CONTENT_CHARS)}...`;
}

function getUntaggedEpisodes(episodes, validThemeIds) {
  return episodes.filter((episode) => {
    const hasValidTheme = episode.themeId && validThemeIds.has(episode.themeId);
    const hasTags =
      episode.tags && Array.isArray(episode.tags) && episode.tags.length > 0;
    return !hasValidTheme || !hasTags;
  });
}

function buildPrompt(episode, themes, allowedTags, podcastName) {
  const content = episode.contentSnippet || episode.content || "";
  const truncatedContent = truncateContent(content);

  return `你正在为《${podcastName}》播客的一期节目进行主题归类和标签打标。

【可选主题列表】
${themes
    .map(
      (t) => `- ID: ${t.id}\n  标题: ${t.title}\n  说明: ${t.description}`,
    )
    .join("\n")}

【本期节目信息】
标题：${episode.title}
内容摘要：${truncatedContent}

【任务】
1. 从上方"可选主题列表"中选出最符合本期节目内容的主题，填入 themeId（必须是列表中已有的 ID，不可自造）
2. 从下方"可选标签列表"中选出 2-3 个最贴合本期节目的标签，填入 tags（必须从列表中选取，不可自造新标签）

【可选标签列表】
${Array.from(allowedTags)
    .map((tag) => `- ${tag}`)
    .join("\n")}

返回 JSON（只返回 JSON，不要其他内容）：
{
  "themeId": "主题 ID",
  "tags": ["标签 1", "标签 2"]
}
`;
}

async function tagEpisodes() {
  if (!isAiEnabled()) {
    const cfg = loadSiteConfig();
    cfg.features = cfg.features || {};
    cfg.features.aiTagging = true;
    writeOverrides(cfg);
    console.log("ℹ️ 检测到终端手动触发，已自动开启 AI 标签功能 (features.aiTagging = true)");
  }

  const siteConfig = loadSiteConfig();
  const podcastName = siteConfig?.brand?.name || "该播客";

  const themes = readJson(THEMES_PATH, "Themes");
  const taxonomy = readJson(TAG_TAXONOMY_PATH, "Tag taxonomy");
  const episodes = readJson(EPISODES_PATH, "Episodes");

  const allowedTags = new Set(Array.isArray(taxonomy.tags) ? taxonomy.tags : []);
  const tagAliases =
    taxonomy.aliases && typeof taxonomy.aliases === "object"
      ? taxonomy.aliases
      : {};

  if (allowedTags.size === 0) {
    console.error("Tag taxonomy is empty. Please provide a non-empty tags list.");
    process.exit(1);
  }

  const validThemeIds = new Set(themes.map((t) => t.id));
  let episodesToProcess = [];

  if (ids.length > 0) {
    const selectedIds = new Set(ids);
    episodesToProcess = episodes.filter((episode) =>
      selectedIds.has(episode.id),
    );
    if (episodesToProcess.length === 0) {
      console.log("No matching episodes found for provided ids.");
      return;
    }
    console.log(`Processing ${episodesToProcess.length} selected episodes...`);
  } else {
    const untaggedEpisodes = getUntaggedEpisodes(episodes, validThemeIds);
    console.log(`Found ${untaggedEpisodes.length} untagged episodes.`);

    if (untaggedEpisodes.length === 0) {
      console.log("All episodes are tagged!");
      return;
    }

    episodesToProcess = untaggedEpisodes.slice(0, limit);
    console.log(`Processing batch of ${episodesToProcess.length} episodes...`);
  }

  let updatedCount = 0;
  let finishedCount = 0;
  const total = episodesToProcess.length;
  const activeConcurrency = Math.min(concurrency, total);

  console.log(`🚀 启动智能打标 (并发数: ${activeConcurrency}，待处理: ${total} 期)...\n`);

  async function processOne(episode) {
    const prompt = buildPrompt(episode, themes, allowedTags, podcastName);

    try {
      const result = await askAI(
        prompt,
        `你是《${podcastName}》播客的内容分类助手。请严格按照给定的主题和标签列表进行归类，只返回合法的 JSON，不要输出任何其他内容。`,
        { temperature: 0.2 },
      );

      if (result && result.themeId && result.tags) {
        const matchedTheme = themes.find((t) => t.id === result.themeId);

        if (matchedTheme) {
          const index = episodes.findIndex((e) => e.id === episode.id);
          if (index !== -1) {
            episodes[index].themeId = result.themeId;
            const normalizedTags = normalizeTags(
              result.tags,
              tagAliases,
              allowedTags,
            );
            const fallbackTags = normalizeTags(
              matchedTheme.representativeTags,
              tagAliases,
              allowedTags,
            );
            const finalTags = fillTags(normalizedTags, fallbackTags, 2, 3);
            episodes[index].tags = finalTags;
            updatedCount++;
            writeEpisodes(episodes);
            finishedCount++;
            console.log(`[${finishedCount}/${total}] ✓ [${episode.id}] ${episode.title.slice(0, 22)}... -> #${matchedTheme.title} (${finalTags.join(", ")})`);
            return;
          }
        } else {
          console.warn(`[${episode.id}] ⚠️ AI 返回了无效主题 ID '${result.themeId}'，已跳过。`);
        }
      } else {
        console.warn(`[${episode.id}] ⚠️ AI 返回格式不正确`);
      }
    } catch (error) {
      console.error(`[${episode.id}] ❌ 打标失败 [${episode.title.slice(0, 20)}]:`, error.message);
    }
    finishedCount++;
  }

  const workers = Array.from({ length: activeConcurrency }, async () => {
    while (episodesToProcess.length > 0) {
      const ep = episodesToProcess.shift();
      if (!ep) break;
      await processOne(ep);
    }
  });

  await Promise.all(workers);

  console.log(`🎉 智能打标完成！本次成功处理并更新了 ${updatedCount} 期单集的主题与标签。`);
}

tagEpisodes().catch((error) => {
  console.error(error);
  process.exit(1);
});
