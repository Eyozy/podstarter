import DOMPurify from "isomorphic-dompurify";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PRIVATE_HOST_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|0\.0\.0\.0|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/iu;

/**
 * 只允许公网可抓取的 http(s) 地址，阻断 SSRF 到内网与云元数据端点。
 */
function assertPublicHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    throw new Error("链接格式不合法，请提供完整的 http(s) 地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http(s) 链接");
  }
  if (PRIVATE_HOST_PATTERN.test(parsed.hostname)) {
    throw new Error("不允许抓取内网或本地地址");
  }
  return parsed;
}

function sanitizeShownotes(html) {
  return DOMPurify.sanitize(String(html || ""), {
    ALLOWED_TAGS: ["p", "br", "b", "i", "em", "strong", "a", "ul", "ol", "li"],
    ALLOWED_ATTR: ["href", "target", "rel"],
  });
}

/**
 * 智能解析各大播客平台的 URL，自动提取或转换为可抓取的 RSS / API 结果
 * @param {string} rawInput
 * @returns {Promise<import("../types").ResolvedPodcastResult>}
 */
export async function resolvePodcastInput(rawInput) {
  const input = String(rawInput || "").trim();
  if (!input) {
    throw new Error("请输入播客链接或 RSS 订阅源地址");
  }

  // 1. Apple Podcasts / iTunes 播客主页链接反查
  const appleMatch =
    input.match(/podcasts\.apple\.com\/(?:[a-zA-Z-]+|\w+)\/podcast\/(?:[^/]+\/)?id(\d+)/i) ||
    input.match(/podcasts\.apple\.com\/podcast\/id(\d+)/i) ||
    input.match(/itunes\.apple\.com\/(?:[a-zA-Z-]+|\w+)\/podcast\/(?:[^/]+\/)?id(\d+)/i);

  if (appleMatch) {
    const itunesId = appleMatch[1];
    let feedUrl;
    let trackName;
    // 优先尝试全区查询
    const lookupUrls = [
      `https://itunes.apple.com/lookup?id=${itunesId}`,
      `https://itunes.apple.com/lookup?id=${itunesId}&country=cn`,
      `https://itunes.apple.com/lookup?id=${itunesId}&country=us`,
    ];

    for (const lUrl of lookupUrls) {
      try {
        const res = await fetch(lUrl, { headers: { "User-Agent": BROWSER_UA } });
        if (res.ok) {
          const data = await res.json();
          if (data.results && data.results[0] && data.results[0].feedUrl) {
            feedUrl = data.results[0].feedUrl;
            trackName = data.results[0].trackName;
            break;
          }
        }
      } catch {
        // continue
      }
    }

    if (!feedUrl) {
      throw new Error(`未能从 Apple Podcasts 识别到底层 RSS 订阅源 (ID: ${itunesId})，请确认该节目公开可访问`);
    }

    return {
      type: "rss",
      platform: "apple",
      platformUrl: input,
      feedUrl,
      title: trackName,
    };
  }

  // 2. 喜马拉雅 (Ximalaya) 专辑主页
  const ximalayaMatch = input.match(/ximalaya\.com\/(?:[a-zA-Z0-9_-]+\/)?album\/(\d+)/i);
  if (ximalayaMatch) {
    const albumId = ximalayaMatch[1];
    return {
      type: "rss",
      platform: "ximalaya",
      platformUrl: input.replace(/\.xml$/i, ""),
      feedUrl: `https://www.ximalaya.com/album/${albumId}.xml`,
      headers: { "User-Agent": BROWSER_UA },
    };
  }

  // 3. 网易云音乐 (NetEase Cloud Music) 电台主页
  const isNetEase = input.includes("music.163.com") && (input.includes("djradio") || input.includes("radio"));
  const neteaseIdMatch = input.match(/[?&]id=(\d+)/i) || input.match(/\/radio\/(\d+)/i) || input.match(/\/djradio\/(\d+)/i);

  if (isNetEase && neteaseIdMatch) {
    const radioId = neteaseIdMatch[1];
    return await resolveNetEaseRadio(radioId, input);
  }

  // 4. 小宇宙 (Xiaoyuzhou) 网页链接
  let xyzWebUrl = null;
  try {
    const candidate = new URL(input);
    if (
      (candidate.hostname === "xiaoyuzhoufm.com" || candidate.hostname === "www.xiaoyuzhoufm.com") &&
      /^\/podcast\/[a-zA-Z0-9]+\/?$/u.test(candidate.pathname)
    ) {
      xyzWebUrl = candidate.toString();
    }
  } catch {
    // 非 URL 输入，跳过小宇宙网页解析
  }
  if (xyzWebUrl) {
    const resolved = await resolveXiaoyuzhouWeb(xyzWebUrl);
    if (resolved) return resolved;
  }

  // 5. 默认作为标准 RSS XML 处理 (包括 https://feed.xyzfm.space/...)
  const isXiaoyuzhouRss = input.includes("xyzfm.space");
  assertPublicHttpUrl(input);
  return {
    type: "rss",
    platform: isXiaoyuzhouRss ? "xiaoyuzhou" : "rss",
    feedUrl: input,
    headers: { "User-Agent": BROWSER_UA },
  };
}

/**
 * 处理网易云播客电台抓取与格式化
 */
async function resolveNetEaseRadio(radioId, platformUrl) {
  const res = await fetch(`https://music.163.com/api/dj/program/byradio?radioId=${radioId}&limit=100&offset=0`, {
    headers: {
      "User-Agent": BROWSER_UA,
      Referer: "https://music.163.com/",
    },
  });

  if (!res.ok) {
    throw new Error(`网易云电台请求失败：HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.code !== 200 || !Array.isArray(data.programs)) {
    throw new Error(data.message || "未能解析网易云播客单集数据，请确认电台 ID 有效");
  }

  const radio = data.programs[0]?.radio;
  const allPrograms = [...data.programs];
  const totalCount = data.count || allPrograms.length;

  if (totalCount > 100) {
    const remainingOffsets = [];
    for (let offset = 100; offset < totalCount && offset < 3000; offset += 100) {
      remainingOffsets.push(offset);
    }

    const pageResults = await Promise.all(
      remainingOffsets.map(async (offset) => {
        try {
          const nextRes = await fetch(
            `https://music.163.com/api/dj/program/byradio?radioId=${radioId}&limit=100&offset=${offset}`,
            {
              headers: {
                "User-Agent": BROWSER_UA,
                Referer: "https://music.163.com/",
              },
            }
          );
          if (!nextRes.ok) return [];
          const nextData = await nextRes.json();
          return Array.isArray(nextData.programs) ? nextData.programs : [];
        } catch {
          return [];
        }
      })
    );

    for (const progs of pageResults) {
      allPrograms.push(...progs);
    }
  }

  const episodes = allPrograms.map((p, idx) => {
    const durationMs = p.duration || p.mainSong?.duration || 0;
    const durSec = Math.floor(durationMs / 1000);
    const m = Math.floor(durSec / 60);
    const s = durSec % 60;
    const durationStr = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

    // 音频大小兜底计算：标准 128kbps = ~16KB/s，防止尺寸显示为 0 MB
    const estimatedBytes = durSec > 0 ? Math.round(durSec * 16000) : 10485760;
    const fileLength = String(p.mainSong?.size && p.mainSong.size > 0 ? p.mainSong.size : estimatedBytes);

    // 单集期数优先从标题抽取（如 #405、第 405 期、E405），保证编号真实对齐
    const titleEpMatch = (p.name || "").match(/(?:#|vol\.?|e|第)\s*(\d+)/i) || (p.name || "").match(/^(\d+)[\.\s、]/);
    const episodeNum = titleEpMatch ? titleEpMatch[1] : String(allPrograms.length - idx);

    const cleanId = `netease-${p.id}`;
    const songId = p.mainSong?.id || p.id;

    return {
      id: cleanId,
      title: p.name || `Episode ${idx + 1}`,
      link: `https://music.163.com/program?id=${p.id}`,
      pubDate: new Date(p.createTime || Date.now()).toUTCString(),
      content: p.description ? `<p>${p.description.replace(/\n/g, "<br/>")}</p>` : "",
      contentSnippet: (p.description || "").slice(0, 300),
      enclosure: {
        url: `/api/stream?id=${songId}`,
        type: "audio/mpeg",
        length: fileLength,
      },
      itunes: {
        duration: durationStr,
        image: p.coverUrl || radio?.picUrl || "",
        episode: episodeNum,
      },
      themeId: "",
      tags: [],
      archived: false,
    };
  });

  return {
    type: "netease",
    platform: "netease",
    platformUrl,
    title: radio?.name || "网易云播客",
    author: radio?.dj?.nickname || "",
    description: radio?.desc || "",
    cover: radio?.picUrl || "",
    episodes,
  };
}

/**
 * 处理小宇宙网页链接解析
 */
async function resolveXiaoyuzhouWeb(webUrl) {
  try {
    const res = await fetch(webUrl, { headers: { "User-Agent": BROWSER_UA } });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/);
    if (!match) return null;

    const data = JSON.parse(match[1]);

    const podcast = data.props?.pageProps?.podcast;
    if (!podcast) return null;

    // 尝试在 iTunes 查询该播客的权威全量 RSS 订阅源
    if (podcast.title) {
      try {
        const searchRes = await fetch(
          `https://itunes.apple.com/search?term=${encodeURIComponent(podcast.title)}&media=podcast&limit=3`
        );
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          const feedUrl = searchData.results?.[0]?.feedUrl;
          if (feedUrl) {
            return {
              type: "rss",
              platform: "xiaoyuzhou",
              platformUrl: webUrl,
              feedUrl,
              title: podcast.title,
              description: podcast.description || podcast.brief,
              cover: podcast.image?.large || podcast.image?.smallOriginalUrl,
            };
          }
        }
      } catch {
        // continue
      }
    }

    // 若未在 iTunes 找到，且页面自带单集，构建直传单集
    if (Array.isArray(podcast.episodes) && podcast.episodes.length > 0) {
      const episodes = podcast.episodes.map((ep, idx) => {
        const cleanId = String(ep.eid || `xyz-${idx}`).replace(/[^a-zA-Z0-9_-]/g, "");
        const durSec = Number(ep.duration || 0);
        const m = Math.floor(durSec / 60);
        const s = durSec % 60;
        const durationStr = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

        return {
          id: cleanId,
          title: ep.title || `Episode ${idx + 1}`,
          link: ep.eid ? `https://www.xiaoyuzhoufm.com/episode/${ep.eid}` : `/episodes/${cleanId}`,
          pubDate: new Date(ep.pubDate || Date.now()).toUTCString(),
          content: ep.shownotes
            ? `<p>${sanitizeShownotes(ep.shownotes).replace(/\n/g, "<br/>")}</p>`
            : `<p>${sanitizeShownotes(ep.description || "")}</p>`,
          contentSnippet: (ep.description || ep.shownotes || "").slice(0, 300),
          enclosure: {
            url: ep.enclosure?.url || ep.media?.source?.url || "",
            type: "audio/x-m4a",
            length: "0",
          },
          itunes: {
            duration: durationStr,
            image: ep.image?.large || ep.image?.smallOriginalUrl || podcast.image?.large || "",
            episode: String(podcast.episodes ? podcast.episodes.length - idx : idx + 1),
          },
          themeId: "",
          tags: [],
          archived: false,
        };
      });

      return {
        type: "direct",
        platform: "xiaoyuzhou",
        platformUrl: webUrl,
        title: podcast.title,
        author: podcast.author,
        description: podcast.description || podcast.brief,
        cover: podcast.image?.large || podcast.image?.smallOriginalUrl,
        episodes,
      };
    }
  } catch {
    // ignore
  }

  return null;
}
