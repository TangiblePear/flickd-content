import { generateTitles } from "./gemini";
import { pickPromptFor } from "./prompts";
import { resolveTmdb } from "./tmdb";

interface Env {
  CONTENT_BUCKET: R2Bucket;
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


export default {
  // No fetch handler — files are served directly via R2 public access
  // on the flickto-content bucket (mapped to flickto.app).

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

  await env.CONTENT_BUCKET.put(`content/daily/${iso}.json`, body, {
    httpMetadata: { contentType: "application/json" },
  });
  await env.CONTENT_BUCKET.put("content/daily/latest.json", body, {
    httpMetadata: { contentType: "application/json" },
  });

  console.log(`daily-ai: wrote ${iso} (${items.length} items, theme="${prompt.theme}")`);
}
