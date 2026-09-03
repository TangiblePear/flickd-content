import { generateTitles } from "./gemini";
import { pickPromptFor } from "./prompts";
import { resolveTmdb } from "./tmdb";
import { generateGameForDate } from "./game/generate";
import { generateReelForDate } from "./game/generateReel";

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

  /**
   * Two independent daily jobs share this cron because the Cloudflare account is at the
   * hard five-cron-per-account limit and this worker already holds the R2 binding both
   * need. They are isolated from each other on purpose: the AI list depends on Gemini and
   * TMDB, the puzzle depends on the detail cache, and a bad day for one of those must not
   * take the other down with it. An unhandled throw here would abandon whichever job had
   * not run yet.
   */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const at = new Date(event.scheduledTime);

    try {
      await generateForDate(at, env);
    } catch (err) {
      console.error("daily-ai: list generation failed", err);
    }

    try {
      await generateGameForDate(at, env);
    } catch (err) {
      console.error("daily-ai: One Take generation failed", err);
    }

    /*
     * Every game in the suite rolls over on THIS trigger.
     *
     * Not because a cron slot could not be spared -- see wrangler.toml, where the
     * "account is at the cap" claim is recorded as unverified -- but because they all
     * roll over at the same instant by design, so a second trigger would buy nothing and
     * add a way for the games to disagree about what day it is.
     *
     * Each generator gets its OWN try/catch and they run in sequence, so one game failing
     * to publish cannot take the others down with it. That matters more as the list grows:
     * a shared handler with one catch would let a TMDB outage during Reel silently cost
     * the day its Flickdl too.
     */
    try {
      await generateReelForDate(at, env);
    } catch (err) {
      console.error("daily-ai: Reel generation failed", err);
    }
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
