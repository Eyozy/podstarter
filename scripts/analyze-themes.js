import { askAI, getActiveAiInfo } from "./ai-client.js";
import { isAiEnabled, loadSiteConfig } from "./site-config.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// 用途：
// 1. 基于节目标题与摘要，先让 AI 提炼核心标签
// 2. 再基于这些标签生成 3-5 个主题分类
// 3. 输出到 src/data/themes.json
//
// 对应命令：
// - npm run analyze
//   默认均匀抽样模式，只抽样部分节目，成本较低
// - npm run analyze:full
//   全量模式，使用全部节目摘要，结果更完整但更慢、更贵
//
// 注意：
// - 这个脚本只负责“生成主题分类体系”
// - 不会给单集节目写入 themeId / tags
// - 会覆盖现有的 src/data/themes.json

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EPISODES_FILE = path.join(__dirname, "../src/data/episodes.json");
const THEMES_FILE = path.join(__dirname, "../src/data/themes.json");
const TAG_TAXONOMY_FILE = path.join(__dirname, "../src/data/tag-taxonomy.json");

// ── 抽样模式（默认）的参数 ───────────────────────────────────────────────────
// 从全部节目中按位置均匀选取 N 期，确保早中晚期内容都被覆盖。
// 例如：共 200 期取 30 个，则分别取第 0、7、14、21...193 期，而非随机或只取最新。
// 建议值 20-50，过多可能导致 AI 响应变慢或超出上下文限制（取决于所用模型）。
const SAMPLE_EPISODE_COUNT = 30;

// ── 两种模式共用的摘要截断长度 ────────────────────────────────────────────────
// 全量模式下，300 期 × 500 字 ≈ 15 万字符，主流模型（128K～1M 上下文）均可承受。
const SAMPLE_SNIPPET_LENGTH = 500;

// ── 解析命令行参数 ─────────────────────────────────────────────────────────────
// 支持 --full 参数：使用全量模式（发送所有节目 + 摘要）
// 默认为均匀抽样模式（发送 SAMPLE_EPISODE_COUNT 期）
// 用法：
//   node scripts/analyze-themes.js          ← 均匀抽样（默认）
//   node scripts/analyze-themes.js --full   ← 全量模式
const useFullMode = process.argv.includes("--full");

async function readEpisodes() {
  const episodesData = await fs.readFile(EPISODES_FILE, "utf-8");
  return JSON.parse(episodesData);
}

/**
 * 均匀抽样：从全部节目中按位置均匀选取 count 期。
 * 取样位置为 0, step, 2*step, ... 其中 step = 总期数 / count，保证覆盖全时间线。
 */
function sampleEpisodesEvenly(episodes, count) {
  if (episodes.length <= count) return episodes;
  const step = episodes.length / count;
  const sampled = [];
  for (let i = 0; i < count; i++) {
    const index = Math.min(Math.floor(i * step), episodes.length - 1);
    sampled.push(episodes[index]);
  }
  return sampled;
}

async function analyzeThemes() {
  // 检查 AI 功能是否启用
  if (!isAiEnabled()) {
    console.log("❌ AI 标签/主题功能未启用（features.aiTagging = false）");
    console.log("   如需使用此功能，请在 site.json 中设置 features.aiTagging: true");
    process.exit(1);
  }

  // 从 site.json 动态读取播客名称和描述，模板用户换播客后无需修改脚本
  const siteConfig = loadSiteConfig();
  const podcastName = siteConfig?.brand?.name || "该播客";
  const podcastDescription = siteConfig?.brand?.meta?.description || "";
  const podcastContext = podcastDescription
    ? `播客名称：《${podcastName}》\n播客简介：${podcastDescription}`
    : `播客名称：《${podcastName}》`;

  console.log("Reading episodes...");
  try {
    const episodes = await readEpisodes();

    // 根据模式决定发送给 AI 的节目列表
    let episodesToAnalyze;
    if (useFullMode) {
      episodesToAnalyze = episodes;
      console.log(`模式：全量（共 ${episodes.length} 期，含摘要）`);
      console.log(`  预计 Token 消耗：约 ${Math.round(episodes.length * SAMPLE_SNIPPET_LENGTH / 2)} tokens（仅摘要部分）`);
    } else {
      episodesToAnalyze = sampleEpisodesEvenly(episodes, SAMPLE_EPISODE_COUNT);
      console.log(`模式：均匀抽样（共 ${episodes.length} 期 → 取 ${episodesToAnalyze.length} 期，按位置均匀分布）`);
    }

    const episodeData = episodesToAnalyze.map((ep) => ({
      title: ep.title,
      contentSnippet: ep.contentSnippet
        ? ep.contentSnippet.substring(0, SAMPLE_SNIPPET_LENGTH)
        : "",
    }));

    console.log(`Analyzing ${episodeData.length} episodes...`);

    // Step 1：让 AI 从节目内容中自由归纳核心标签，不预设维度方向，避免偏离播客真实调性
    const step1Prompt = `你正在分析一档中文播客的节目内容。
${podcastContext}

请仔细阅读以下节目的标题和摘要，从内容本身归纳出 10-15 个核心标签（关键词）。

播客节目数据：
${JSON.stringify(episodeData)}

要求：
1. 完全基于节目内容自然归纳，不要套用固定的分类框架
2. 标签应贴近这档播客真实的内容调性，从节目实际讨论的话题中提取
3. 标签应为简洁的中文词汇（2-5 字），具体且有区分度，避免过于宽泛
4. 优先提炼节目中反复出现的高频话题

返回 JSON 格式：
{
  "tags": ["标签 1", "标签 2", ...]
}`;

    console.log("Step 1: Generating tags from episode content...");
    const aiInfo = getActiveAiInfo();
    console.log(`Provider: ${aiInfo.provider}`);
    console.log(`API URL: ${aiInfo.apiUrl}`);
    console.log(`Model: ${aiInfo.model}`);

    const tagsResult = await askAI(
      step1Prompt,
      "你是一位专业的中文播客内容分析师。请严格按照要求输出合法的 JSON，不要输出任何其他内容。",
    );

    if (!tagsResult.tags || !Array.isArray(tagsResult.tags)) {
      throw new Error("Failed to generate tags from AI response");
    }

    console.log("Generated tags:", tagsResult.tags.join(", "));

    // Step 2：基于 Step 1 的标签 + 节目数据生成主题，约束 ID 格式避免中文或空格
    const step2Prompt = `你正在为一档中文播客设计主题分类体系。
${podcastContext}

基于以下从节目内容中提炼的核心标签，以及节目数据，请生成 3-5 个主题分类：

核心标签：
${JSON.stringify(tagsResult.tags)}

节目数据参考：
${JSON.stringify(episodeData)}

要求：
1. 每个主题起一个有质感的 2-4 字中文标题，符合这档播客的内容气质
2. 用一句话描述该主题的核心内容
3. 为每个主题分配 3-5 个最具代表性的标签（必须从上方"核心标签"列表中选取）
4. 主题之间内容要有明显区分，不要互相重叠
5. id 字段使用小写英文字母和下划线，例如 daily_life、self_growth，不要使用中文或空格

返回 JSON 数组格式（不要包裹在其他字段里，直接返回数组）：
[
  {
    "id": "theme_id",
    "title": "中文标题",
    "description": "一句话描述",
    "representativeTags": ["标签 1", "标签 2"]
  }
]`;

    console.log("Step 2: Generating themes based on tags...");

    const themesResult = await askAI(
      step2Prompt,
      "你是一位富有创意的中文播客内容策划师。请严格按照要求输出合法的 JSON 数组，不要输出任何其他内容。",
    );

    let themes;
    if (Array.isArray(themesResult)) {
      themes = themesResult;
    } else if (themesResult.themes && Array.isArray(themesResult.themes)) {
      themes = themesResult.themes;
    } else {
      const values = Object.values(themesResult);
      const arrayValue = values.find((v) => Array.isArray(v));
      if (arrayValue) {
        themes = arrayValue;
      } else {
        throw new Error("AI did not return an array of themes");
      }
    }

    if (!Array.isArray(themes)) {
      throw new Error("Failed to extract themes array from AI response");
    }

    themes.forEach((theme) => {
      if (
        !theme.id ||
        !theme.title ||
        !theme.description ||
        !theme.representativeTags
      ) {
        throw new Error(`Invalid theme object: ${JSON.stringify(theme)}`);
      }
    });

    console.log("Themes generated:", themes.map((t) => t.title).join(", "));

    await fs.writeFile(THEMES_FILE, JSON.stringify(themes, null, 2));
    console.log(`Themes saved to ${THEMES_FILE}`);

    // 保存自动生成的标签库白名单，供后续打标使用，避免标签发散
    const taxonomy = {
      tags: tagsResult.tags,
      aliases: {} // 初始为空，后续可在此处新增手动维护的别名
    };
    await fs.writeFile(TAG_TAXONOMY_FILE, JSON.stringify(taxonomy, null, 2));
    console.log(`Tag taxonomy saved to ${TAG_TAXONOMY_FILE}`);
  } catch (error) {
    console.error("Error analyzing themes:", error);
    process.exit(1);
  }
}

analyzeThemes();
