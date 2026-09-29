import rawEpisodes from "../data/episodes.json";
import type { Episode } from "../types";

export const allEpisodes = rawEpisodes as Episode[];
export const publishedEpisodes: Episode[] = allEpisodes.filter((ep) => ep.archived !== true);

// 构建机时区不确定（Netlify/CI 为 UTC，本地为 +08），统一按节目所在地渲染日期。
const DISPLAY_TIME_ZONE = "Asia/Shanghai";

export function formatEpisodeDate(pubDate: string, options?: Intl.DateTimeFormatOptions): string {
  return new Date(pubDate).toLocaleDateString("zh-CN", {
    timeZone: DISPLAY_TIME_ZONE,
    ...options,
  });
}

export function episodeYear(pubDate: string): number {
  return Number(
    new Date(pubDate).toLocaleDateString("en-US", {
      timeZone: DISPLAY_TIME_ZONE,
      year: "numeric",
    })
  );
}

export function parseDurationToSeconds(durationStr?: string): number {
  if (!durationStr) return 0;
  const parts = durationStr.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

export function extractEpisodeNumber(episode: { title?: string; itunes?: { episode?: string | number } }, fallback = "00"): string {
  if (episode.itunes?.episode && episode.itunes.episode !== "Special") {
    return String(episode.itunes.episode);
  }
  const title = episode.title || "";
  const match = title.match(/(?:#|vol\.?|e|第)\s*(\d+)/i) || title.match(/^(\d+)[\.\s、]/);
  return match ? match[1] : fallback;
}

export function estimateFileSize(durationStr?: string): string | null {
  const totalSec = parseDurationToSeconds(durationStr);
  if (totalSec <= 0) return null;
  return `${((totalSec * 16000) / (1024 * 1024)).toFixed(1)} MB`;
}
