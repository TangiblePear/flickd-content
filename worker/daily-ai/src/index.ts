import { generateTitles } from "./gemini";
import { pickPromptFor } from "./prompts";
import { resolveTmdb } from "./tmdb";

interface Env {
  FLICKD_DAILY: R2Bucket;
  GEMINI_API_KEY: string;
  TMDB_API_KEY: string;
  TARGET_COUNT: string;
}

interface DailyItem {
  tmdbId: number;
  title: string;
  type: "MOVIE" | "TV";
  posterUrl: string | null;
  reason: string;
}

interface DailyList {
  date: string;
  theme: string;
  promptId: string;
  items: DailyItem[];
}

const CACHE_CONTROL = "public, max-age=300, s-maxage=300";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/content\/daily\/(latest|\d{4}-\d{2}-\d{2})\.json$/);
    if (!m || req.method !== "GET") {
      return new Response("not found", { status: 404 });
    }
    const key = `${m[1]}.json`;
    const object = await env.FLICKD_DAILY.get(key);
    if (!object) return new Response("not found", { status: 404 });
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": CACHE_CONTROL,
        ETag: object.httpEtag,
      },
    });
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    await generateForDate(new Date(event.scheduledTime), env);
  },
};

async function generateForDate(date: Date, env: Env): Promise<void> {
  const iso = date.toISOString().slice(0, 10);
  const prompt = pickPromptFor(date);
  const targetCount = Number(env.TARGET_COUNT ?? "10");

  const titles = await generateTitles(env.GEMINI_API_KEY, prompt.instruction, targetCount);

  const items: DailyItem[] = [];
  for (const t of titles) {
    const resolved = await resolveTmdb(env.TMDB_API_KEY, t.title, t.type, t.year);
    if (!resolved) continue;
    items.push({
      ...resolved,
      reason: t.reason?.slice(0, 200) ?? "",
    });
    if (items.length >= targetCount) break;
  }

  if (items.length === 0) {
    console.error(`daily-ai: no titles resolved for ${iso} prompt=${prompt.id}`);
    return;
  }

  const payload: DailyList = {
    date: iso,
    theme: prompt.theme,
    promptId: prompt.id,
    items,
  };
  const body = JSON.stringify(payload, null, 2);

  await env.FLICKD_DAILY.put(`${iso}.json`, body, {
    httpMetadata: { contentType: "application/json" },
  });
  await env.FLICKD_DAILY.put("latest.json", body, {
    httpMetadata: { contentType: "application/json" },
  });

  console.log(`daily-ai: wrote ${iso} (${items.length} items, theme="${prompt.theme}")`);
}
