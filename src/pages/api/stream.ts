import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id || !/^\d+$/.test(id)) {
    return new Response("Invalid or missing song id", { status: 400 });
  }
  try {
    const outerUrl = `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`;
    const res = await fetch(outerUrl, { redirect: "manual" });
    const location = res.headers.get("location");
    if (!location) {
      return new Response("Audio stream location not found", { status: 404 });
    }
    let targetUrl: URL;
    try {
      targetUrl = new URL(location);
      if (!["http:", "https:"].includes(targetUrl.protocol)) {
        return new Response("Invalid redirect protocol", { status: 502 });
      }
    } catch {
      return new Response("Malformed redirect location", { status: 502 });
    }

    targetUrl.protocol = "https:";
    return new Response(null, {
      status: 302,
      headers: {
        Location: targetUrl.toString(),
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
