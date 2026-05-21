import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { askAI } from "./ai-client.js";
import { isAiEnabled, loadSiteConfig } from "./site-config.js";
import { normalizeTags, fillTags } from "./utils.js";

// 用途：
// 1. 读取现有的 src/data/themes.json
// 2. 让 AI 为单集节目选择 themeId，并生成 2-3 个标签
// 3. 回写到 src/data/episodes.json
//
// 对应命令：
// - npm run tag
//   默认一次只处理 5 期未打标节目
// - node scripts/tag-episodes.js --limit 20
//   一次处理更多未打标节目
// - node scripts/tag-episodes.js --ids id1,id2
//   只处理指定节目
//
// 注意：
// - 这个脚本依赖已存在的 themes.json 和 tag-taxonomy.json
// - 这个脚本负责“给节目写入 themeId / tags”
// - 不负责生成主题分类体系

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "../src/data");
const EPISODES_PATH = path.join(DATA_DIR, "episodes.json");
const THEMES_PATH = path.join(DATA_DIR, "themes.json");
const TAG_TAXONOMY_PATH = path.join(DATA_DIR, "tag-taxonomy.json");

// 每次运行默认只处理 5 期节目，防止一次性调用 AI 过多导致费用过高或被限流。
// 如需一次性处理所有未打标节目，请运行：node scripts/tag-episodes.js --limit 9999
const DEFAULT_LIMIT = 5;
const MAX_CONTENT_CHARS = 800;
// 每次 AI 请求之间的间隔（毫秒），避免触发 API 限流
const REQUEST_DELAY_MS = 1500;

const { limit, ids } = parseArgs(process.argv.slice(2));

function parseArgs(args) {
  const parsed = {
    limit: DEFAULT_LIMIT,
    ids: [],
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--limit" && args[i + 1]) {
      parsed.limit = parseInt(args[i + 1], 10);
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
  fs.writeFileSync(EPISODES_PATH, JSON.stringify(episodes, null, 2));
}

// normalizeTags 和 fillTags 已提取到 scripts/utils.js，从那里统一导入。

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

  // 提示词使用中文，与节目内容语言一致，避免语言切换导致的语义偏差
  // podcastName 从 site.json 动态读取，模板用户换播客后无需修改此脚本
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
  // 检查 AI 功能是否启用
  if (!isAiEnabled()) {
    console.log("❌ AI 标签/主题功能未启用（features.aiTagging = false）");
    console.log("   如需使用此功能，请在 site.json 中设置 features.aiTagging: true");
    process.exit(1);
  }

  // 从 site.json 动态读取播客名称，模板用户换播客后无需修改脚本
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
    // Find episodes that don't have tags OR don't have a valid themeId
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

  for (const episode of episodesToProcess) {
    console.log(`Tagging [${episode.id}]: ${episode.title}...`);

    const prompt = buildPrompt(episode, themes, allowedTags, podcastName);

    try {
      const result = await askAI(
        prompt,
        `你是《${podcastName}》播客的内容分类助手。请严格按照给定的主题和标签列表进行归类，只返回合法的 JSON，不要输出任何其他内容。`,
        { temperature: 0.2 },
      );

      if (result && result.themeId && result.tags) {
        // Validation: Check if themeId exists
        const matchedTheme = themes.find((t) => t.id === result.themeId);

        if (matchedTheme) {
          // Find the episode in the main array to update it
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
            console.log(`  -> Theme: ${matchedTheme.title} (${result.themeId})`);
            console.log(`  -> Tags: ${finalTags.join(", ")}`);

            // Save after every successful update to be safe
            writeEpisodes(episodes);
          }
        } else {
          console.warn(
            `  Warning: AI returned invalid themeId '${result.themeId}'. Skipping assignment.`,
          );
        }
      } else {
        console.warn("  Invalid response format from AI");
      }
    } catch (error) {
      console.error(`  Failed to tag ${episode.title}:`, error.message);
    }

    // Small delay between requests
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
  }

  console.log(`Finished processing. Updated ${updatedCount} episodes.`);
}

tagEpisodes().catch((error) => {
  console.error(error);
  process.exit(1);
});
