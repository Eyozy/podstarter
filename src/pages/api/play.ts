import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { isValidTranscriptId } from '../../utils/auth';
import { atomicWriteJson } from '../../../scripts/utils.js';

export const prerender = false; // Server-rendered endpoint

const DATA_FILE = path.join(process.cwd(), 'src/data/play-counts.json');
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 小时去重窗口（符合 IAB 播客计量规范）
const recentHits = new Map<string, number[]>();
const MAX_TRACKED_IDS = 10000;

/**
 * 计数器依赖可写磁盘。Netlify Functions 的 bundle 目录只读，写入必然失败，
 * 此时返回 unavailable 让前端隐藏播放量，而不是静默丢数据。
 */
function isCounterWritable(): boolean {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.accessSync(path.dirname(DATA_FILE), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function getCounts(): Record<string, number> {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return (JSON.parse(raw) || {}) as Record<string, number>;
  } catch {
    return {};
  }
}

function saveCounts(counts: Record<string, number>): void {
  atomicWriteJson(DATA_FILE, counts);
}

function isDuplicateHit(hitKey: string): boolean {
  const now = Date.now();

  if (recentHits.size > MAX_TRACKED_IDS) {
    for (const [id, timestamps] of recentHits) {
      if (timestamps.every((ts) => now - ts >= WINDOW_MS)) recentHits.delete(id);
    }
    if (recentHits.size > MAX_TRACKED_IDS) recentHits.clear();
  }

  const hits = (recentHits.get(hitKey) || []).filter((ts) => now - ts < WINDOW_MS);
  if (hits.length > 0) {
    recentHits.set(hitKey, hits);
    return true;
  }

  recentHits.set(hitKey, [now]);
  return false;
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const episodeId = url.searchParams.get('episodeId');
  const counts = getCounts();

  if (episodeId !== null) {
    return new Response(
      JSON.stringify({ count: counts[episodeId] || 0 }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return new Response(
    JSON.stringify({ counts }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as { episodeId?: unknown };
    const episodeId = typeof body.episodeId === 'string' ? body.episodeId.trim() : '';

    if (!episodeId) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing episodeId' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    if (!isValidTranscriptId(episodeId)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid episodeId' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-real-ip") ||
      "127.0.0.1";
    const userAgent = (request.headers.get("user-agent") || "").slice(0, 60);
    const hitKey = `${episodeId}:${clientIp}:${userAgent}`;

    if (isDuplicateHit(hitKey)) {
      const counts = getCounts();
      return new Response(
        JSON.stringify({ success: true, counted: false, count: counts[episodeId] || 0 }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    if (!isCounterWritable()) {
      return new Response(
        JSON.stringify({ success: false, error: 'Play counter storage is not writable in this deployment' }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const counts = getCounts();
    const newCount = (counts[episodeId] || 0) + 1;
    counts[episodeId] = newCount;
    saveCounts(counts);

    return new Response(
      JSON.stringify({ success: true, count: newCount }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: 'Internal server error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
