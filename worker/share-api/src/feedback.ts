// ── In-app feedback ──────────────────────────────────────────────────────────
// One write path for the app's feedback form, and two read/act paths for the admin
// panel's queue. Migration 0025 holds the table.
//
// The submit endpoint takes an OPTIONAL session. Requiring one would silence exactly
// the people worth hearing from — someone stuck in onboarding, or whose sign-in is the
// thing that is broken. An anonymous row is still a useful row; it just carries no
// `user_id`, and account erasure therefore cannot (and need not) reach it.
//
// The admin endpoints are gated by the shared ADMIN_KEY, never a user session — same
// reasoning as `moderationQueue.ts` and `insights.ts`: the admin is not a user of this
// system, so an account takeover must not become a support-inbox takeover.

import { adminAuthorized } from "./commentsAdmin";

export interface FeedbackEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
  ADMIN_KEY?: string;
  /** Per-IP hourly submit cap. Falls back to 5 — deliberately lower than share-create. */
  FEEDBACK_PER_HOUR?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

/**
 * The topics the form offers. An unknown topic is rejected rather than coerced to
 * "other": the picker is a closed set, so anything else is a client bug or someone
 * poking the endpoint, and both are worth seeing as a 400.
 */
export const FEEDBACK_TOPICS = ["bug", "idea", "content", "sync", "account", "other"] as const;
export type FeedbackTopic = (typeof FEEDBACK_TOPICS)[number];

const MESSAGE_MAX = 2000;
const CONTACT_MAX = 200;
const FIELD_MAX = 120;
/** One page of the admin queue. */
const QUEUE_LIMIT = 100;
const STATES = ["new", "triaged", "closed"] as const;

interface SubmitBody {
  topic?: string;
  message?: string;
  contact?: string;
  platform?: string;
  appVersion?: string;
  versionCode?: number;
  device?: string;
  osVersion?: string;
  locale?: string;
}

/** Trim, collapse nothing, and cap. Empty becomes null so the column stays honest. */
function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

async function rateLimited(env: FeedbackEnv, ip: string, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const key = `rl/feedback/${ip}/${new Date().toISOString().slice(0, 13)}.json`;
  const existing = await env.BUCKET.get(key);
  const count = existing ? (((await existing.json().catch(() => null)) as { n?: number } | null)?.n ?? 0) : 0;
  if (count >= limit) return true;
  await env.BUCKET.put(key, JSON.stringify({ n: count + 1 }), {
    httpMetadata: { contentType: "application/json" },
  });
  return false;
}

/**
 * `POST /api/feedback` — file one piece of feedback.
 *
 * [userId] comes from the caller, which has already resolved the session (or not).
 * Passing it in rather than resolving here keeps this module free of the auth import
 * and makes the anonymous path explicit at the call site.
 */
export async function handlePostFeedback(
  req: Request,
  env: FeedbackEnv,
  userId: string | null,
): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = Number(env.FEEDBACK_PER_HOUR ?? "5");
  if (await rateLimited(env, ip, limit)) return json({ error: "rate_limited" }, 429);

  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  const topic = typeof body.topic === "string" ? body.topic.trim().toLowerCase() : "";
  if (!(FEEDBACK_TOPICS as readonly string[]).includes(topic)) {
    return json({ error: "bad_topic" }, 400);
  }
  const message = clip(body.message, MESSAGE_MAX);
  if (!message) return json({ error: "empty_message" }, 400);

  const now = Date.now();
  const id = crypto.randomUUID();
  const versionCode =
    typeof body.versionCode === "number" && Number.isFinite(body.versionCode)
      ? Math.trunc(body.versionCode)
      : null;

  await env.DB.prepare(
    `INSERT INTO feedback
       (id, user_id, topic, message, contact, platform, app_version, version_code,
        device, os_version, locale, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
  )
    .bind(
      id,
      userId,
      topic,
      message,
      clip(body.contact, CONTACT_MAX),
      clip(body.platform, FIELD_MAX),
      clip(body.appVersion, FIELD_MAX),
      versionCode,
      clip(body.device, FIELD_MAX),
      clip(body.osVersion, FIELD_MAX),
      clip(body.locale, FIELD_MAX),
      now,
    )
    .run();

  return json({ ok: true, id });
}

interface FeedbackRow {
  id: string;
  user_id: string | null;
  topic: string;
  message: string;
  contact: string | null;
  platform: string | null;
  app_version: string | null;
  version_code: number | null;
  device: string | null;
  os_version: string | null;
  locale: string | null;
  state: string;
  admin_note: string | null;
  created_at: number;
  updated_at: number | null;
  display_name: string | null;
}

/**
 * `GET /api/feedback/admin?state=new|triaged|closed|all&topic=…&cursor=…`
 *
 * Newest first. `counts` carries the per-state and per-topic totals across the whole
 * table, not just this page — the panel's filter chips have to show what is behind
 * them, and computing that from a page would understate every number.
 */
export async function handleAdminFeedbackList(req: Request, env: FeedbackEnv): Promise<Response> {
  if (!adminAuthorized(req, env as never)) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const stateParam = url.searchParams.get("state") ?? "new";
  const state = (STATES as readonly string[]).includes(stateParam) ? stateParam : "all";
  const topicParam = url.searchParams.get("topic");
  const topic = topicParam && (FEEDBACK_TOPICS as readonly string[]).includes(topicParam) ? topicParam : null;
  const cursor = Number(url.searchParams.get("cursor")) || Number.MAX_SAFE_INTEGER;

  const where: string[] = ["f.created_at < ?"];
  const binds: unknown[] = [cursor];
  if (state !== "all") {
    where.push("f.state = ?");
    binds.push(state);
  }
  if (topic) {
    where.push("f.topic = ?");
    binds.push(topic);
  }

  // LEFT JOIN, not JOIN: an anonymous row has no `user_id` at all, and an inner join
  // would silently drop exactly the submissions that arrived without an account.
  const { results } = await env.DB.prepare(
    `SELECT f.*, p.display_name
       FROM feedback f LEFT JOIN profiles p ON p.user_id = f.user_id
      WHERE ${where.join(" AND ")}
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ${QUEUE_LIMIT}`,
  )
    .bind(...binds)
    .all<FeedbackRow>();

  const stateCounts = await env.DB.prepare(
    "SELECT state, COUNT(*) AS n FROM feedback GROUP BY state",
  ).all<{ state: string; n: number }>();
  const topicCounts = await env.DB.prepare(
    "SELECT topic, COUNT(*) AS n FROM feedback GROUP BY topic",
  ).all<{ topic: string; n: number }>();

  const items = (results ?? []).map((r) => ({
    id: r.id,
    userId: r.user_id,
    displayName: r.display_name,
    topic: r.topic,
    message: r.message,
    contact: r.contact,
    platform: r.platform,
    appVersion: r.app_version,
    versionCode: r.version_code,
    device: r.device,
    osVersion: r.os_version,
    locale: r.locale,
    state: r.state,
    adminNote: r.admin_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return json({
    items,
    // Absent when the page is short — the panel uses its presence, not a count, to
    // decide whether a "load more" exists.
    cursor: items.length === QUEUE_LIMIT ? items[items.length - 1].createdAt : null,
    counts: {
      states: Object.fromEntries((stateCounts.results ?? []).map((r) => [r.state, r.n])),
      topics: Object.fromEntries((topicCounts.results ?? []).map((r) => [r.topic, r.n])),
    },
  });
}

/** `POST /api/feedback/admin/act` — `{ id, state?, note? }`. */
export async function handleAdminFeedbackAct(req: Request, env: FeedbackEnv): Promise<Response> {
  if (!adminAuthorized(req, env as never)) return json({ error: "unauthorized" }, 401);

  let body: { id?: string; state?: string; note?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const id = clip(body.id, 64);
  if (!id) return json({ error: "missing_id" }, 400);

  const state = typeof body.state === "string" && (STATES as readonly string[]).includes(body.state)
    ? body.state
    : null;
  // `note` is distinguishable from absent: an explicit empty string clears it.
  const noteGiven = typeof body.note === "string";
  const note = noteGiven ? clip(body.note, MESSAGE_MAX) : null;
  if (!state && !noteGiven) return json({ error: "nothing_to_do" }, 400);

  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [Date.now()];
  if (state) {
    sets.push("state = ?");
    binds.push(state);
  }
  if (noteGiven) {
    sets.push("admin_note = ?");
    binds.push(note);
  }
  binds.push(id);

  const res = await env.DB.prepare(`UPDATE feedback SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  // `changes` is 0 for an id that does not exist. Reporting ok:true there would let the
  // panel show a state the database never took.
  if (!res.meta?.changes) return json({ error: "not_found" }, 404);
  return json({ ok: true });
}
