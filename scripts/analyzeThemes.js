import { askAI, getActiveAiInfo } from "./aiClient.js";
import { isAiEnabled, loadSiteConfig, writeOverrides } from "./siteConfig.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EPISODES_FILE = path.join(__dirname, "../src/data/episodes.json");
const THEMES_FILE = path.join(__dirname, "../src/data/themes.json");
const TAG_TAXONOMY_FILE = path.join(__dirname, "../src/data/tag-taxonomy.json");

const SAMPLE_EPISODE_COUNT = 30;
const SAMPLE_SNIPPET_LENGTH = 500;
const useFullMode = process.argv.includes("--full");

async function readEpisodes() {
  const episodesData = await fs.readFile(EPISODES_FILE, "utf-8");
  return JSON.parse(episodesData);
}

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
  if (!isAiEnabled()) {
    const cfg = loadSiteConfig();
    cfg.features = cfg.features || {};
    cfg.features.aiTagging = true;
    writeOverrides(cfg);
    console.log("ℹ️ 检测到终端手动触发，已自动开启 AI 标签功能 (features.aiTagging = true)");
  }

  const siteConfig = loadSiteConfig();
  const podcastName = siteConfig?.brand?.name || "该播客";
  const podcastDescription = siteConfig?.brand?.meta?.description || "";
  const podcastContext = podcastDescription
    ? `播客名称：《${podcastName}》\n播客简介：${podcastDescription}`
    : `播客名称：《${podcastName}》`;

  console.log("Reading episodes...");
  try {
    const episodes = await readEpisodes();

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

    const step1Prompt = `你是一位专业的内容架构师与播客分类分析专家。
请深入分析以下中文播客的节目数据（标题与摘要）：
${podcastContext}

播客节目数据：
${JSON.stringify(episodeData)}

【任务目标】
从节目内容中提炼 15-20 个具有高区分度、真实覆盖全站内容生态的核心标签（Keywords）。

【分类学准则】
1. 自底向上归纳：完全忠实于节目实际讨论的具体议题与高频对象，严禁凭空套用虚构的框架。
2. 具象与辨识度：提取具体的讨论领域、场景、问题类型或核心矛盾（2-5 字中文），杜绝空泛无实质的虚词（如“感受”、“生活”、“故事”、“漫谈”等）。
3. 维度均衡覆盖：标签需兼顾播客涉及的多个面向（如核心专业探讨、现实生存与实践、心理体验、人际互动、宏观观察等），不可单向堆叠。

返回严格的 JSON 格式：
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

    const step2Prompt = `你是一位专业的信息架构师（Information Architect）。
请基于以下从播客《${podcastName}》中归纳的核心标签以及节目样本，为这档播客构建一套清晰、立体、边界清晰的主题分类体系（Taxonomy）：

播客信息：
${podcastContext}

核心标签池：
${JSON.stringify(tagsResult.tags)}

节目样本参考：
${JSON.stringify(episodeData)}

【分类架构核心准则】
1. MECE 原则（相互独立、完全穷尽）：
   - 3-5 个分类（若话题离散度高可扩至 6 个），分类之间边界清晰、互不重叠。
   - 杜绝同义反复（如避免将同一生活/专业范畴拆成两个并列分类）。
   - 整体架构应能自然容纳全站 80% 以上不同侧重的单集。
2. 风格化命名与具象描述结合：
   - title（主题标题）：2-4 个字，精准符合本播客的独特性格（技术类严谨精准、文艺生活类自省有质感、商业类干练敏锐）。
   - description（主题简介）：用一句话清楚点明该分类聚焦的【核心客体、具体场景或核心问题】，语言简洁精炼，严禁全是空洞无物的抒情废话。
3. 标签映射：每个主题分配 3-5 个最具代表性的标签（必须严格从上方的“核心标签池”中挑选）。
4. 语义化 ID：id 必须使用有英文业务含义的小写字母与下划线（例如 career_development, system_design, human_relations 等），严禁拼音或随意编号。

返回严格的 JSON 数组格式（不要包裹在任何外部属性内，直接以 '[' 开始）：
[
  {
    "id": "theme_id",
    "title": "主题标题",
    "description": "清晰的一句话范围与核心说明",
    "representativeTags": ["标签1", "标签2", "标签3"]
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

    const taxonomy = {
      tags: tagsResult.tags,
      aliases: {} // 初始为空，后续可在此处新增手动维护的别名
    };
    await fs.writeFile(TAG_TAXONOMY_FILE, JSON.stringify(taxonomy, null, 2));
    console.log(`Tag taxonomy saved to ${TAG_TAXONOMY_FILE}`);

    const currentConfig = loadSiteConfig();
    currentConfig.features = currentConfig.features || {};
    currentConfig.features.themes = true;
    writeOverrides(currentConfig);
    console.log("Features updated: themes enabled in site.json");
  } catch (error) {
    console.error("Error analyzing themes:", error);
    process.exit(1);
  }
}

analyzeThemes();
