import type { APIRoute } from "astro";
import fs from "node:fs";
import path from "node:path";
import Parser from "rss-parser";
import DOMPurify from "isomorphic-dompurify";
import { convertTranscript } from "../../../scripts/convertTranscript.js";
import { resetData } from "../../../scripts/resetData.js";
import { askAI } from "../../../scripts/aiClient.js";
import type { Episode, ResolvedPodcastResult } from "../../types";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  buildAdminCookieValue,
  isValidAdminCookie,
  isValidTranscriptId,
  readEnvMap,
  resolveAdminPassword,
  verifyAdminPassword,
} from "../../utils/auth";
import { loadSiteConfig, writeOverrides, deepMerge } from "../../../scripts/siteConfig.js";
import { atomicWriteFile, atomicWriteJson } from "../../../scripts/utils.js";
import { getProviderEnvPrefix } from "../../../scripts/aiProviderConfig.js";
import { resolvePodcastInput } from "../../utils/resolver";

export const prerender = false;

const ROOT = process.cwd();
const EPISODES_PATH = path.join(ROOT, "src/data/episodes.json");
const readSiteConfig = () => loadSiteConfig() as Record<string, unknown>;
const TRANSCRIPTS_DIR = path.join(ROOT, "src/content/transcripts");
const PLAY_COUNTS_PATH = path.join(ROOT, "src/data/play-counts.json");
const ENV_PATH = path.join(ROOT, ".env");

const dataCorrupted = (filePath: string) =>
  new Error(`数据文件损坏，已拒绝写入以免覆盖：${filePath}`);

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function readEpisodes(): Episode[] {
  try {
    return readJson<Episode[]>(EPISODES_PATH, []);
  } catch {
    throw dataCorrupted(EPISODES_PATH);
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWriteJson(filePath, data);
}

function readPlayCounts(): Record<string, number> {
  try {
    return readJson<Record<string, number>>(PLAY_COUNTS_PATH, {});
  } catch {
    throw dataCorrupted(PLAY_COUNTS_PATH);
  }
}

const PRIVATE_HOST_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|0\.0\.0\.0|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/iu;

export function isPublicHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return !PRIVATE_HOST_PATTERN.test(parsed.hostname);
}

function sanitizeEpisodeContent(html: string): string {
  return DOMPurify.sanitize(String(html || ""), {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "a", "ul", "ol", "li",
      "h2", "h3", "img", "figure", "figcaption", "blockquote",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "class"],
    ALLOW_DATA_ATTR: false,
  });
}

function transcriptFileFor(id: string): string | null {
  return isValidTranscriptId(id) ? path.join(TRANSCRIPTS_DIR, `${id}.md`) : null;
}

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ success: false, error: "未授权，请先登录管理后台" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function envLineFor(key: string, value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/[\s#"'$]/.test(value)
    ? `${key}=${value}`
    : `${key}=${JSON.stringify(value)}`;
}

function writeEnvMap(updates: Record<string, string>): void {
  const existingLines = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, "utf-8").split("\n")
    : [];
  const pending = new Map(Object.entries(updates));
  const output: string[] = [];

  for (const line of existingLines) {
    const eqIdx = line.indexOf("=");
    const key = eqIdx === -1 ? "" : line.slice(0, eqIdx).trim();
    if (!pending.has(key)) {
      output.push(line);
      continue;
    }
    output.push(envLineFor(key, pending.get(key)!));
    pending.delete(key);
  }

  for (const [key, value] of pending) {
    output.push(envLineFor(key, value));
  }

  atomicWriteFile(ENV_PATH, output.join("\n").replace(/\n+$/, "") + "\n");
}

/**
 * Secure cookie 在明文 HTTP 下会被浏览器丢弃，本地局域网调试会静默登不上，
 * 因此仅在实际 HTTPS 连接时下发该标志。
 */
function secureCookieFlag(request: Request): string {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const isHttps = (proto || new URL(request.url).protocol.replace(":", "")) === "https";
  return isHttps ? "; Secure" : "";
}

export const GET: APIRoute = async ({ request }) => {
  if (!isValidAdminCookie(request.headers.get("cookie") || "", resolveAdminPassword())) {
    return unauthorizedResponse();
  }

  const siteConfig = readSiteConfig();
  const envMap = readEnvMap();

  let episodes: Episode[];
  let playCounts: Record<string, number>;
  try {
    episodes = readEpisodes();
    playCounts = readPlayCounts();
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const placeholderNotice = String(
    (siteConfig.transcripts as Record<string, unknown> | undefined)?.placeholderNotice ?? ""
  ).trim();

  const episodesWithStatus = episodes.map((ep) => {
    const transcriptFile = transcriptFileFor(ep.id);
    let transcriptStatus: "ready" | "placeholder" | "missing" = "missing";

    if (transcriptFile && fs.existsSync(transcriptFile)) {
      const content = fs.readFileSync(transcriptFile, "utf-8");
      if (placeholderNotice && content.includes(placeholderNotice)) {
        transcriptStatus = "placeholder";
      } else {
        transcriptStatus = "ready";
      }
    }

    return {
      ...ep,
      plays: playCounts[ep.id] || 0,
      transcriptStatus,
    };
  });

  const envProvider = envMap.AI_PROVIDER || process.env.AI_PROVIDER || "deepseek";
  const prefix = getProviderEnvPrefix(envProvider) || "DEEPSEEK";
  const hasApiKey = Boolean(envMap[`${prefix}_API_KEY`] || process.env[`${prefix}_API_KEY`]);
  const envModel = envMap[`${prefix}_MODEL`] || process.env[`${prefix}_MODEL`] || "";
  const envApiUrl = envMap[`${prefix}_API_URL`] || process.env[`${prefix}_API_URL`] || "";

  const aiConfig = {
    provider: envProvider,
    hasApiKey,
    model: envModel,
    apiUrl: envApiUrl,
  };

  return new Response(
    JSON.stringify({
      success: true,
      site: siteConfig,
      episodes: episodesWithStatus,
      playCounts,
      aiConfig,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
};

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const MAX_TRACKED_LOGIN_KEYS = 5000;
const loginFailures = new Map<string, { count: number; firstAt: number }>();

function clientKey(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function sweepLoginFailures(now: number): void {
  for (const [key, entry] of loginFailures) {
    if (now - entry.firstAt > LOGIN_WINDOW_MS) loginFailures.delete(key);
  }
}

function isLoginThrottled(key: string): boolean {
  const now = Date.now();
  // 轮换来源 IP 同样能撑大此表，定时清扫防止内存耗尽。
  if (loginFailures.size > MAX_TRACKED_LOGIN_KEYS) sweepLoginFailures(now);

  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key: string): void {
  const entry = loginFailures.get(key);
  if (!entry || Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || "").trim();

    // output:'static' 下 Astro 的 checkOrigin 不生效，这里自行校验同源，挡住跨站表单提交。
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) {
      return new Response(JSON.stringify({ success: false, error: "跨站请求已拒绝" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "login") {
      const throttleKey = clientKey(request);
      if (isLoginThrottled(throttleKey)) {
        return new Response(
          JSON.stringify({ success: false, error: "尝试次数过多，请 15 分钟后再试" }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }

      const adminPass = resolveAdminPassword();
      if (!adminPass) {
        return new Response(
          JSON.stringify({ success: false, error: "服务端未配置 ADMIN_PASSWORD，无法登录管理后台" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }

      if (!verifyAdminPassword(body.password, adminPass)) {
        recordLoginFailure(throttleKey);
        return new Response(JSON.stringify({ success: false, error: "管理员密码错误，请核对后重试" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      loginFailures.delete(throttleKey);

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": `${ADMIN_COOKIE_NAME}=${buildAdminCookieValue(adminPass)}; Path=/; HttpOnly${secureCookieFlag(request)}; SameSite=Lax; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`,
        },
      });
    }

    if (action === "logout") {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly${secureCookieFlag(request)}; SameSite=Lax; Max-Age=0`,
        },
      });
    }

    if (!isValidAdminCookie(request.headers.get("cookie") || "", resolveAdminPassword())) {
      return unauthorizedResponse();
    }

    if (action === "analyze-themes") {
      const episodes = readEpisodes();
      if (episodes.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: "当前暂无节目，请先同步播客后再分析主题" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      let generatedThemes = [
        { id: "growth", title: "生活与个人成长", description: "关于日常经验、自我探索与内心秩序的对话。" },
        { id: "culture", title: "文化与精神生活", description: "文学、艺术与具体时代情绪的观察记录。" },
        { id: "society", title: "工作与现代社会", description: "探讨职业选择、人际边界与社会观察。" },
      ];

      try {
        const sample = episodes.slice(0, 30);
        const summaries = sample.map((e) => `${e.title}: ${e.contentSnippet.slice(0, 150)}`).join("\n");
        const prompt = `你是一位专业的内容架构师。请根据以下播客节目摘要，自底向上归纳提炼出 3-5 个遵循 MECE 原则（相互独立、完全穷尽、边界分明）的核心主题分类。
要求：
1. 每个分类包含 id (英文业务标识，如 career_growth), title (2-4字精准中文标题), description (一句话说明该分类涵盖的具体场景与客体)。
2. 主题之间互不重叠，能自然容纳全站大多数节目的核心讨论范畴。
3. 严格返回 JSON 数组格式，不要包含任何 markdown 围栏或额外文字。

节目摘要：
${summaries.slice(0, 2000)}`;
        const aiResponse = (await askAI(prompt, "You are a professional podcast information architect that outputs a strict JSON array.")) as unknown;
        if (Array.isArray(aiResponse) && aiResponse.length > 0) {
          generatedThemes = aiResponse as typeof generatedThemes;
        }
      } catch {}

      writeJson(path.join(ROOT, "src/data/themes.json"), generatedThemes);

      const siteConfig = readSiteConfig();
      const featuresObj = (siteConfig.features || {}) as Record<string, boolean>;
      featuresObj.themes = true;
      siteConfig.features = featuresObj;
      writeOverrides(siteConfig);

      return new Response(
        JSON.stringify({ success: true, themes: generatedThemes }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (action === "sync-rss") {
      const rawInput = String(body.rssUrl || "").trim();
      const updateSiteMeta = body.updateSiteMeta !== false;

      if (!rawInput) {
        return new Response(
          JSON.stringify({ success: false, error: "请输入有效的播客主页链接或 RSS 订阅源地址" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      let resolved: ResolvedPodcastResult;
      try {
        resolved = await resolvePodcastInput(rawInput);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(
          JSON.stringify({ success: false, error: msg }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      let importedEpisodes: Episode[] = [];
      let podcastTitle = "播客";
      let podcastDesc = "";
      let podcastAuthor = "";
      let podcastCover = "";

      if (resolved.type === "netease" || resolved.type === "direct") {
        importedEpisodes = resolved.episodes || [];
        podcastTitle = resolved.title || podcastTitle;
        podcastDesc = resolved.description || "";
        podcastAuthor = resolved.author || "";
        podcastCover = resolved.cover || "";
      } else {
        const feedUrl = resolved.feedUrl || rawInput;
        const parser = new Parser({
          requestOptions: {
            headers: resolved.headers || {
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
          },
          customFields: {
            item: [
              ["itunes:duration", "duration"],
              ["itunes:image", "image"],
              ["itunes:episode", "episode"],
            ],
          },
        });

        const feed = await parser.parseURL(feedUrl);
        if (!feed || !Array.isArray(feed.items)) {
          return new Response(
            JSON.stringify({ success: false, error: "无法解析该 RSS 源，请确认地址可公开访问" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        const rawFeed = feed as unknown as Record<string, unknown>;
        const rawFeedImage = rawFeed.image && typeof rawFeed.image === "object" ? (rawFeed.image as Record<string, unknown>) : null;
        const rawFeedItunes = (rawFeed.itunes && typeof rawFeed.itunes === "object" ? rawFeed.itunes : {}) as Record<string, unknown>;
        importedEpisodes = feed.items.map((item, index) => {
          const raw = item as unknown as Record<string, unknown>;
          const itunesRaw = (raw.itunes && typeof raw.itunes === "object" ? raw.itunes : {}) as Record<string, unknown>;
          const rawImage = raw.image && typeof raw.image === "object" ? (raw.image as Record<string, unknown>) : null;
          const guid = raw.guid || raw.id || `ep-${index}`;
          const cleanId =
            String(guid)
              .replace(/^.*\/episode\//, "")
              .replace(/\?.*$/, "")
              .replace(/[^a-zA-Z0-9_-]/g, "") || `ep-${index}`;

          const itemImage =
            (typeof raw.image === "string" ? raw.image : (rawImage?.url as string)) ||
            (itunesRaw.image as string) ||
            (rawFeedImage?.url as string) ||
            "";

          const titleStr = (raw.title as string) || `Episode ${index + 1}`;
          const titleEpMatch = titleStr.match(/(?:#|vol\.?|e|第)\s*(\d+)/i) || titleStr.match(/^(\d+)[\.\s、]/);
          const durationStr = String(itunesRaw.duration || raw.duration || "00:00");
          const epStr = String(itunesRaw.episode || raw.episode || (titleEpMatch ? titleEpMatch[1] : (feed.items.length - index)));
          const enclosureRaw = (raw.enclosure && typeof raw.enclosure === "object" ? raw.enclosure : {}) as Record<string, unknown>;

          let fileLength = String(enclosureRaw.length || "0");
          if (fileLength === "0" || !fileLength) {
            const parts = durationStr.split(":").map(Number);
            let durSec = 0;
            if (parts.length === 3) durSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
            else if (parts.length === 2) durSec = parts[0] * 60 + parts[1];
            else if (parts.length === 1) durSec = parts[0];
            if (durSec > 0) fileLength = String(Math.round(durSec * 16000));
          }

          return {
            id: cleanId,
            title: titleStr,
            link: (raw.link as string) || `/episodes/${cleanId}`,
            pubDate: (raw.pubDate as string) || new Date().toUTCString(),
            content: sanitizeEpisodeContent(
              (raw.content as string) || (raw.contentSnippet as string) || ""
            ),
            contentSnippet: (raw.contentSnippet as string) || "",
            enclosure: {
              url: (enclosureRaw.url as string) || "",
              type: (enclosureRaw.type as string) || "audio/x-m4a",
              length: fileLength,
            },
            itunes: {
              duration: durationStr,
              image: itemImage,
              episode: epStr,
            },
            themeId: "",
            tags: [],
            archived: false,
          };
        });

        podcastTitle = feed.title || resolved.title || podcastTitle;
        podcastDesc = feed.description || resolved.description || "";
        const authorField = (rawFeedItunes.author || (rawFeedItunes.owner && typeof rawFeedItunes.owner === "object" ? (rawFeedItunes.owner as Record<string, unknown>).name : "")) as string;
        podcastAuthor = authorField || resolved.author || "";
        podcastCover = (rawFeedImage?.url as string) || (rawFeedItunes.image as string) || resolved.cover || "";
      }

      const existingById = new Map(readEpisodes().map((ep) => [ep.id, ep]));
      const mergedEpisodes = importedEpisodes.map((incoming) => {
        const existing = existingById.get(incoming.id);
        if (!existing) return incoming;
        return {
          ...incoming,
          itunes: { ...(existing.itunes || {}), ...(incoming.itunes || {}) },
          themeId: existing.themeId ?? incoming.themeId,
          tags: Array.isArray(existing.tags) ? existing.tags : incoming.tags,
          archived: existing.archived ?? incoming.archived,
        };
      });

      writeJson(EPISODES_PATH, mergedEpisodes);

      const siteConfig = readSiteConfig();
      const isTranscriptsOn = (siteConfig.features as Record<string, boolean> | undefined)?.transcripts === true;
      if (isTranscriptsOn) {
        try {
          if (!fs.existsSync(TRANSCRIPTS_DIR)) {
            fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
          }
          const placeholder =
            (siteConfig.transcripts as Record<string, string> | undefined)?.placeholderNotice || "文字稿整理中...";
          for (const ep of mergedEpisodes) {
            const tPath = path.join(TRANSCRIPTS_DIR, `${ep.id}.md`);
            if (!fs.existsSync(tPath)) {
              const safeTitle = (ep.title || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
              const tmpl = `---\ntitle: "${safeTitle}"\ncontributors: []\n---\n\n> ${placeholder}\n`;
              fs.writeFileSync(tPath, tmpl, "utf-8");
            }
          }
        } catch {
          // ignore transcript write errors
        }
      }

      if (updateSiteMeta) {
        const podcastObj = (siteConfig.podcast || {}) as Record<string, unknown>;
        if (resolved.feedUrl) {
          podcastObj.rssUrl = resolved.feedUrl;
        } else if (rawInput) {
          podcastObj.rssUrl = rawInput;
        }
        if (resolved.platform === "apple" && resolved.platformUrl) {
          podcastObj.appleUrl = resolved.platformUrl;
        } else if (resolved.platform === "ximalaya" && resolved.platformUrl) {
          podcastObj.ximalayaUrl = resolved.platformUrl;
        } else if (resolved.platform === "netease" && resolved.platformUrl) {
          podcastObj.neteaseUrl = resolved.platformUrl;
        } else if (resolved.platform === "xiaoyuzhou" && resolved.platformUrl) {
          podcastObj.xiaoyuzhouUrl = resolved.platformUrl;
        }
        siteConfig.podcast = podcastObj;

        const brandObj = (siteConfig.brand || {}) as Record<string, unknown>;
        if (podcastTitle) {
          brandObj.name = podcastTitle;
        }
        const brandMeta = (brandObj.meta || {}) as Record<string, unknown>;
        if (podcastDesc) {
          brandMeta.description = podcastDesc;
        }
        if (podcastAuthor) {
          brandMeta.author = podcastAuthor;
        }
        brandObj.meta = brandMeta;
        siteConfig.brand = brandObj;

        if (podcastCover) {
          const assetsObj = (siteConfig.assets || {}) as Record<string, unknown>;
          assetsObj.defaultCover = podcastCover;
          siteConfig.assets = assetsObj;
        }

        writeOverrides(siteConfig);
      }

      return new Response(
        JSON.stringify({
          success: true,
          count: importedEpisodes.length,
          podcastTitle,
          platform: resolved.platform,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (action === "add-episode") {
      const epData = body.episode as Partial<Episode>;
      if (!epData?.title || !epData?.enclosure?.url) {
        return new Response(
          JSON.stringify({ success: false, error: "标题和音频链接为必填项" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const newId = epData.id || "ep-" + Date.now().toString(36);
      if (!isValidTranscriptId(newId)) {
        return new Response(
          JSON.stringify({ success: false, error: "单集 ID 只能包含字母、数字、下划线和连字符" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const episodes = readEpisodes();
      const newEpisode: Episode = {
        id: newId,
        title: epData.title.trim(),
        link: `/episodes/${newId}`,
        pubDate: epData.pubDate || new Date().toUTCString(),
        content: sanitizeEpisodeContent(epData.content || epData.contentSnippet || ""),
        contentSnippet: epData.contentSnippet || "",
        enclosure: {
          url: epData.enclosure.url.trim(),
          type: epData.enclosure.type || "audio/x-m4a",
          length: epData.enclosure.length || "0",
        },
        itunes: {
          duration: epData.itunes?.duration || "00:00",
          image: epData.itunes?.image || "",
          episode: epData.itunes?.episode || (episodes.length + 1).toString(),
        },
        themeId: epData.themeId || "starter_guide",
        tags: Array.isArray(epData.tags) ? epData.tags : [],
        archived: false,
      };

      episodes.unshift(newEpisode);
      writeJson(EPISODES_PATH, episodes);

      return new Response(
        JSON.stringify({ success: true, episode: newEpisode }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (action === "delete-episode") {
      const episodeId = String(body.episodeId || "").trim();
      if (!episodeId) {
        return new Response(
          JSON.stringify({ success: false, error: "缺少 episodeId" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const episodes = readEpisodes();
      const filtered = episodes.filter((ep) => ep.id !== episodeId);
      writeJson(EPISODES_PATH, filtered);

      const transcriptFile = transcriptFileFor(episodeId);
      if (transcriptFile && fs.existsSync(transcriptFile)) {
        try {
          fs.unlinkSync(transcriptFile);
        } catch {}
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (action === "reset-data") {
      try {
        const count = resetData();
        return new Response(JSON.stringify({ success: true, count }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: (err as Error).message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (action === "save-transcript") {
      const episodeId = String(body.episodeId || "").trim();
      const markdown = String(body.markdown || "").trim();
      if (!episodeId || !markdown) {
        return new Response(
          JSON.stringify({ success: false, error: "缺少 episodeId 或 markdown 内容" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      if (!fs.existsSync(TRANSCRIPTS_DIR)) {
        fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
      }

      const filePath = transcriptFileFor(episodeId);
      if (!filePath) {
        return new Response(
          JSON.stringify({ success: false, error: "单集 ID 格式不合法" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      let fileContent = markdown;
      if (!markdown.startsWith("---")) {
        const episodes = readEpisodes();
        const targetEp = episodes.find((ep) => ep.id === episodeId);
        const title = targetEp?.title ? targetEp.title.replace(/"/g, '\\"') : "单集文字稿";
        fileContent = `---\ntitle: "${title}"\ncontributors: []\n---\n\n${markdown}\n`;
      }
      fs.writeFileSync(filePath, fileContent, "utf-8");

      return new Response(
        JSON.stringify({ success: true, filePath: `${episodeId}.md` }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (action === "convert-subtitles") {
      const subtitleText = String(body.subtitles || "").trim();
      if (!subtitleText) {
        return new Response(
          JSON.stringify({ success: false, error: "字幕内容为空" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const result = convertTranscript(subtitleText);
      return new Response(
        JSON.stringify({ success: true, ...result }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (action === "save-config") {
      const configPayload = (body.config || body) as Record<string, unknown>;
      if (!configPayload || typeof configPayload !== "object") {
        return new Response(
          JSON.stringify({ success: false, error: "无效的配置对象" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const current = readSiteConfig();
      const currentSite = ((current.site && typeof current.site === "object" ? current.site : {}) || {}) as Record<string, unknown>;
      const currentBrand = ((current.brand && typeof current.brand === "object" ? current.brand : {}) || {}) as Record<string, unknown>;
      const currentBrandMeta = ((currentBrand.meta && typeof currentBrand.meta === "object" ? currentBrand.meta : {}) || {}) as Record<string, unknown>;
      const currentPodcast = ((current.podcast && typeof current.podcast === "object" ? current.podcast : {}) || {}) as Record<string, unknown>;

      const inputSite = (configPayload.site && typeof configPayload.site === "object" ? configPayload.site : {}) as Record<string, unknown>;
      const inputBrand = (configPayload.brand && typeof configPayload.brand === "object" ? configPayload.brand : {}) as Record<string, unknown>;
      const inputBrandMeta = (inputBrand.meta && typeof inputBrand.meta === "object" ? inputBrand.meta : {}) as Record<string, unknown>;
      const inputPodcast = (configPayload.podcast && typeof configPayload.podcast === "object" ? configPayload.podcast : {}) as Record<string, unknown>;

      if (configPayload.establishedYear !== undefined || inputBrand.establishedYear !== undefined) {
        const yr = parseInt(String(configPayload.establishedYear ?? inputBrand.establishedYear), 10);
        if (Number.isFinite(yr) && yr > 1900) currentBrand.establishedYear = yr;
      }
      if (configPayload.siteUrl !== undefined || inputSite.url !== undefined) {
        currentSite.url = String(configPayload.siteUrl ?? inputSite.url ?? currentSite.url ?? "").trim();
      }
      if (configPayload.brandName !== undefined || inputBrand.name !== undefined) {
        currentBrand.name = String(configPayload.brandName ?? inputBrand.name ?? currentBrand.name ?? "").trim();
      }
      if (configPayload.description !== undefined || inputBrandMeta.description !== undefined) {
        currentBrandMeta.description = String(configPayload.description ?? inputBrandMeta.description ?? currentBrandMeta.description ?? "").trim();
      }
      if (configPayload.author !== undefined || inputBrandMeta.author !== undefined) {
        currentBrandMeta.author = String(configPayload.author ?? inputBrandMeta.author ?? currentBrandMeta.author ?? "").trim();
      }
      if (configPayload.rssUrl !== undefined || inputPodcast.rssUrl !== undefined) {
        currentPodcast.rssUrl = String(configPayload.rssUrl ?? inputPodcast.rssUrl ?? currentPodcast.rssUrl ?? "").trim();
      }
      if (configPayload.appleUrl !== undefined || inputPodcast.appleUrl !== undefined) {
        currentPodcast.appleUrl = String(configPayload.appleUrl ?? inputPodcast.appleUrl ?? "").trim();
      }
      if (configPayload.xiaoyuzhouUrl !== undefined || inputPodcast.xiaoyuzhouUrl !== undefined) {
        currentPodcast.xiaoyuzhouUrl = String(configPayload.xiaoyuzhouUrl ?? inputPodcast.xiaoyuzhouUrl ?? "").trim();
      }
      if (configPayload.ximalayaUrl !== undefined || inputPodcast.ximalayaUrl !== undefined) {
        currentPodcast.ximalayaUrl = String(configPayload.ximalayaUrl ?? inputPodcast.ximalayaUrl ?? "").trim();
      }
      if (configPayload.spotifyUrl !== undefined || inputPodcast.spotifyUrl !== undefined) {
        currentPodcast.spotifyUrl = String(configPayload.spotifyUrl ?? inputPodcast.spotifyUrl ?? "").trim();
      }
      if (configPayload.neteaseUrl !== undefined || inputPodcast.neteaseUrl !== undefined) {
        currentPodcast.neteaseUrl = String(configPayload.neteaseUrl ?? inputPodcast.neteaseUrl ?? "").trim();
      }
      if (configPayload.wechatQr !== undefined || inputPodcast.wechatQr !== undefined) {
        currentPodcast.wechatQr = String(configPayload.wechatQr ?? inputPodcast.wechatQr ?? "").trim();
      }
      if (configPayload.xiaoyuzhouQr !== undefined || inputPodcast.xiaoyuzhouQr !== undefined) {
        currentPodcast.xiaoyuzhouQr = String(configPayload.xiaoyuzhouQr ?? inputPodcast.xiaoyuzhouQr ?? "").trim();
      }

      const currentFeatures = ((current.features && typeof current.features === "object" ? current.features : {}) || {}) as Record<string, boolean>;
      const inputFeatures = (configPayload.features && typeof configPayload.features === "object" ? configPayload.features : {}) as Record<string, boolean>;
      if (configPayload.featureTranscripts !== undefined || inputFeatures.transcripts !== undefined) {
        currentFeatures.transcripts = Boolean(configPayload.featureTranscripts ?? inputFeatures.transcripts);
      }
      if (configPayload.featureAiTagging !== undefined || inputFeatures.aiTagging !== undefined) {
        currentFeatures.aiTagging = Boolean(configPayload.featureAiTagging ?? inputFeatures.aiTagging);
      }
      if (configPayload.featureThemes !== undefined || inputFeatures.themes !== undefined) {
        currentFeatures.themes = Boolean(configPayload.featureThemes ?? inputFeatures.themes);
      }
      current.features = currentFeatures;

      current.site = currentSite;
      currentBrand.meta = currentBrandMeta;
      current.brand = currentBrand;
      current.podcast = currentPodcast;

      if (configPayload.pages && typeof configPayload.pages === "object") {
        const incomingPages = configPayload.pages as Record<string, unknown>;
        const currentPages = (current.pages && typeof current.pages === "object" ? current.pages : {}) as Record<string, unknown>;
        for (const pageKey of Object.keys(incomingPages)) {
          if (incomingPages[pageKey] && typeof incomingPages[pageKey] === "object" && !Array.isArray(incomingPages[pageKey])) {
            currentPages[pageKey] = { ...(currentPages[pageKey] as object ?? {}), ...incomingPages[pageKey] };
          }
        }
        current.pages = currentPages;
      }

      if (Array.isArray(configPayload.navigation)) {
        current.navigation = configPayload.navigation;
      }

      for (const node of ["hero", "footer", "assets", "shareCard", "transcripts"] as const) {
        const incoming = configPayload[node];
        if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
          current[node] = deepMerge(current[node] || {}, incoming);
        }
      }

      writeOverrides(current);

      return new Response(
        JSON.stringify({ success: true, site: current }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (action === "save-about") {
      const aboutData = (body.about || {}) as Record<string, unknown>;
      if (!aboutData || typeof aboutData !== "object") {
        return new Response(
          JSON.stringify({ success: false, error: "关于页配置格式不正确" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const current = readSiteConfig();
      const existingAbout = ((current.about && typeof current.about === "object" ? current.about : {}) || {}) as Record<string, unknown>;

      let members: Array<{ name: string; role?: string; avatar?: string; links: Array<{ label: string; url: string }> }> = [];
      const rawMembers = Array.isArray(aboutData.members)
        ? aboutData.members
        : (Array.isArray(body.members) ? body.members : []);

      if (Array.isArray(rawMembers)) {
        members = rawMembers
          .filter((m) => m && typeof m === "object" && Boolean(String((m as Record<string, unknown>).name || "").trim()))
          .map((m: Record<string, unknown>) => {
            const rawLinks = Array.isArray(m.links) ? m.links : [];
            const links = rawLinks
              .filter((l) => l && typeof l === "object" && Boolean(String((l as Record<string, unknown>).url || "").trim()))
              .map((l: Record<string, unknown>) => ({
                label: String(l.label || "社交链接").trim(),
                url: String(l.url || "").trim(),
              }));
            const item: { name: string; role?: string; avatar?: string; links: Array<{ label: string; url: string }> } = {
              name: String(m.name || "").trim(),
              links,
            };
            if (m.role) item.role = String(m.role).trim();
            if (m.avatar) item.avatar = String(m.avatar).trim();
            return item;
          });
      } else if (Array.isArray(existingAbout.members)) {
        members = existingAbout.members as typeof members;
      }

      const updatedAbout: Record<string, unknown> = {
        ...existingAbout,
        ...aboutData,
        members,
      };

      current.about = updatedAbout;

      for (const node of ["hero", "footer", "assets", "shareCard", "transcripts"] as const) {
        const incoming = body[node];
        if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
          current[node] = deepMerge(current[node] || {}, incoming);
        }
      }

      if (body.pages && typeof body.pages === "object" && !Array.isArray(body.pages)) {
        current.pages = deepMerge(current.pages || {}, body.pages);
      }

      writeOverrides(current);

      return new Response(
        JSON.stringify({ success: true, about: updatedAbout, site: current }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (action === "test-ai") {
      const envMap = readEnvMap();
      const provider = String(body.provider || envMap.AI_PROVIDER || process.env.AI_PROVIDER || "deepseek").trim();
      const prefix = getProviderEnvPrefix(provider) || "DEEPSEEK";

      const submittedKey = String(body.apiKey || "").trim();
      const submittedUrl = String(body.apiUrl || "").trim();

      // 服务端密钥只允许发往服务端已配置的端点，避免被当作任意 URL 的转发器。
      const apiKey = submittedKey || String(envMap[`${prefix}_API_KEY`] || process.env[`${prefix}_API_KEY`] || "").trim();
      const apiUrl = submittedKey ? submittedUrl : String(envMap[`${prefix}_API_URL`] || process.env[`${prefix}_API_URL`] || "").trim();
      const model = String(body.model || envMap[`${prefix}_MODEL`] || process.env[`${prefix}_MODEL`] || "").trim();

      if (submittedKey && !isPublicHttpUrl(submittedUrl)) {
        return new Response(
          JSON.stringify({ success: false, error: "端点 URL 必须是公网可访问的 http(s) 地址" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      if (!apiKey || !apiUrl || !model) {
        return new Response(
          JSON.stringify({ success: false, error: "未检测到 API Key、端点 URL 或模型名称。请在平台环境变量或本地 .env 中配置。" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const startTime = Date.now();
      try {
        const testRes = await fetch(apiUrl, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: "You are a test assistant." },
              { role: "user", content: "Hello" },
            ],
            max_tokens: 10,
            stream: false,
          }),
        });
        clearTimeout(timeoutId);
        const duration = Date.now() - startTime;

        if (testRes.ok) {
          return new Response(
            JSON.stringify({ success: true, duration, status: testRes.status }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } else {
          const errText = await testRes.text().catch(() => "");
          return new Response(
            JSON.stringify({
              success: false,
              status: testRes.status,
              error: `HTTP ${testRes.status}: ${errText.slice(0, 150) || "服务商拒绝连接"}`,
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
      } catch (err) {
        clearTimeout(timeoutId);
        return new Response(
          JSON.stringify({
            success: false,
            error: (err as Error).name === "AbortError" ? "连接超时（12 秒未响应）" : (err as Error).message,
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    if (action === "fetch-models") {
      const apiKey = String(body.apiKey || "").trim();
      const apiUrl = String(body.apiUrl || "").trim();

      if (!apiKey || !apiUrl) {
        return new Response(
          JSON.stringify({ success: false, error: "请先填写 API Key 和端点 URL" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      if (!isPublicHttpUrl(apiUrl)) {
        return new Response(
          JSON.stringify({ success: false, error: "端点 URL 必须是公网可访问的 http(s) 地址" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      let modelsUrl = apiUrl.replace(/\/chat\/completions\/?$/, "/models");
      if (modelsUrl === apiUrl) {
        try {
          const u = new URL(apiUrl);
          modelsUrl = `${u.origin}/v1/models`;
        } catch {
          modelsUrl = `${apiUrl}/models`;
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        const mRes = await fetch(modelsUrl, {
          method: "GET",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });
        clearTimeout(timeoutId);

        if (mRes.ok) {
          const data = (await mRes.json().catch(() => ({}))) as Record<string, unknown>;
          const rawList = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
          const models = rawList
            .map((item) => (typeof item === "string" ? item : (item as Record<string, unknown>)?.id))
            .filter(Boolean)
            .map(String);

          return new Response(
            JSON.stringify({ success: true, models }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } else {
          return new Response(
            JSON.stringify({ success: false, error: `服务商端点返回 HTTP ${mRes.status}` }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
      } catch (err) {
        clearTimeout(timeoutId);
        return new Response(
          JSON.stringify({ success: false, error: (err as Error).message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }


    if (action === "save-ai-config") {
      const provider = String(body.provider || "deepseek").trim();
      const apiKey = String(body.apiKey || "").trim();
      const apiUrl = String(body.apiUrl || "").trim();
      const model = String(body.model || "").trim();

      const prefix = getProviderEnvPrefix(provider) || "DEEPSEEK";
      const envUpdates: Record<string, string> = {
        AI_PROVIDER: provider,
      };
      if (apiKey) envUpdates[`${prefix}_API_KEY`] = apiKey;
      if (apiUrl) envUpdates[`${prefix}_API_URL`] = apiUrl;
      if (model) envUpdates[`${prefix}_MODEL`] = model;

      try {
        writeEnvMap(envUpdates);
      } catch (err) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `本地 .env 写入失败（生产环境文件系统只读）。请在 Netlify Site settings → Environment variables 中配置：${Object.keys(envUpdates).join(", ")}。原始错误：${(err as Error).message}`,
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }

      // dotenv 只在首次 import 时填充 process.env，写盘后需同步，否则本次请求读不到新值。
      Object.assign(process.env, envUpdates);

      const current = readSiteConfig();
      const features = (current.features || {}) as Record<string, boolean>;
      features.aiTagging = true;
      current.features = features;
      writeOverrides(current);

      return new Response(
        JSON.stringify({ success: true, persistedTo: "env-file", envKeys: Object.keys(envUpdates) }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (action === "change-password") {
      const newPassword = String(body.newPassword || "").trim();
      if (!newPassword || newPassword.length < 6) {
        return new Response(
          JSON.stringify({ success: false, error: "新密码不能为空且长度至少为 6 位" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      try {
        writeEnvMap({ ADMIN_PASSWORD: newPassword });
        process.env.ADMIN_PASSWORD = newPassword;
      } catch (err) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `本地 .env 写入失败（生产环境文件系统只读）。请在 Netlify / Vercel 环境变量中直接修改 ADMIN_PASSWORD。原始错误：${(err as Error).message}`,
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }

      const newCookie = buildAdminCookieValue(newPassword);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": `${ADMIN_COOKIE_NAME}=${newCookie}; Path=/; HttpOnly${secureCookieFlag(request)}; SameSite=Lax; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`,
        },
      });
    }

    if (action === "ai-generate-tags") {
      const title = String(body.title || "").trim();
      const notes = String(body.notes || "").trim();

      if (!title && !notes) {
        return new Response(
          JSON.stringify({ success: false, error: "标题或简介至少有一项不为空" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      try {
        const prompt = `你是一个专业的播客内容策划助手。请根据以下节目的标题和内容介绍，提取 3-5 个最契合、最利于搜索引擎与听众检索的内容标签（每个标签 2-6 个字）。
要求：严格只返回一个包含 JSON 数组的纯文本，如 ["标签一", "标签二", "标签三"]，严禁任何额外解释。

【节目标题】：${title}
【节目介绍】：${notes.slice(0, 800)}`;
        const response = (await askAI(
          prompt,
          "You are an assistant that strictly returns a JSON array of strings, e.g. [\"tag1\", \"tag2\"]."
        )) as unknown;

        let tags: string[] = [];
        if (Array.isArray(response)) {
          tags = response.map(String).filter(Boolean);
        } else if (
          response &&
          typeof response === "object" &&
          "tags" in response &&
          Array.isArray(response.tags)
        ) {
          tags = response.tags.map(String).filter(Boolean);
        }

        if (tags.length > 0) {
          return new Response(
            JSON.stringify({ success: true, tags }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      } catch {}

      const candidateSource = `${title} ${notes}`;
      const defaultKeywords = ["独立播客", "创作者", "思考", "生活", "工具", "声音", "自我成长", "记录", "工作流", "技术"];
      const matched = defaultKeywords.filter((k) => candidateSource.includes(k));
      const fallbackTags = matched.length >= 2 ? matched.slice(0, 4) : ["独立创作", "播客", "生活思考"];

      return new Response(
        JSON.stringify({ success: true, tags: fallbackTags, fallback: true }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: "未知操作" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
