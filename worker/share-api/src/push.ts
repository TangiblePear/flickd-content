// ── Account-keyed push topics ────────────────────────────────────────────────
// Step 2 of the friendId retirement: the push record moves off the relay's
// `{friendId}/push.json` and onto the account.
//
// **Columns on `users`, not an R2 object keyed on `users.id`.** `notifyAccount` — the
// path every directed push takes — already reads that row to resolve `friend_id`, so
// putting the topics there makes the lookup part of a query that was happening anyway.
// It removes both the friendId hop and an R2 read from every friend request, match,
// share, comment and poll notification. Subrequests are the binding constraint.
//
// The write is session-authenticated (`resolveSession`), which is the actual point of
// the step: the relay endpoint authenticated on `verifyOwnerBindToken`, so the friendId
// WAS the auth scope. Nothing here needs a friendId to prove ownership.
//
// ⚠️ **Its failure mode is silent.** A device whose push record never publishes is
// unreachable by ANY directed push, and the only symptom is that things quietly arrive
// late — found exactly that way on a tablet, 2026-07-27, with the cause invisible. The
// client keeps its republish heartbeat and its failure log across this move, and
// readers fall back to the relay record rather than treating "no topics" as "no push".

import { resolveSession } from "./auth";

export interface PushEnv {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, X-Revoke-Session, X-App-Version",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

/**
 * What FCM accepts as a topic name. Mirrors `FCM_TOPIC_RE` in fcm.ts — validated on
 * the way IN so a topic that could never be delivered to is never stored. A stored
 * unusable topic looks published and pushes nothing, which is the worst of both.
 */
const TOPIC_RE = /^[a-zA-Z0-9-_.~%]{1,900}$/;

export interface AccountPush {
  selfTopic: string | null;
  friendTopic: string | null;
  /** Still needed to fall back to `{friendId}/push.json`. Goes at step 8. */
  friendId: string | null;
}

/**
 * `PUT /api/me/push` — `{ selfTopic, friendTopic }`.
 *
 * A blank topic CLEARS its column rather than storing `""`: an empty string passes a
 * null check and then fails [TOPIC_RE], leaving a row that reads as published.
 */
export async function handlePutMyPush(req: Request, env: PushEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const clean = (v: unknown): string | null | undefined => {
    if (typeof v !== "string") return undefined; // absent → reject below
    const t = v.trim();
    if (!t) return null; // blank → clear
    return TOPIC_RE.test(t) ? t : undefined;
  };

  const selfTopic = clean(body.selfTopic);
  const friendTopic = clean(body.friendTopic);
  if (selfTopic === undefined || friendTopic === undefined) {
    return json({ error: "invalid_topic" }, 400);
  }

  await env.DB.prepare("UPDATE users SET push_self_topic = ?, push_friend_topic = ? WHERE id = ?")
    .bind(selfTopic, friendTopic, session.userId)
    .run();

  return json({ ok: true });
}

/**
 * The account's push topics, plus its `friend_id` for the relay fallback.
 *
 * ⚠️ **Null topics are NOT "unreachable".** Every install that predates this endpoint
 * has published to `{friendId}/push.json` and nothing else, so a caller that treats
 * null as "no push" makes the entire existing userbase silently unpushable. Callers
 * must fall through to the relay record while `friend_id` is present.
 *
 * Never throws: a push lookup that failed the write which triggered it would turn a
 * notification problem into a data-loss problem.
 */
export async function readAccountPush(db: D1Database, userId: string): Promise<AccountPush | null> {
  try {
    const row = await db
      .prepare("SELECT push_self_topic, push_friend_topic, friend_id FROM users WHERE id = ?")
      .bind(userId)
      .first<{ push_self_topic: string | null; push_friend_topic: string | null; friend_id: string | null }>();
    if (!row) return null;
    return {
      selfTopic: row.push_self_topic ?? null,
      friendTopic: row.push_friend_topic ?? null,
      friendId: row.friend_id ?? null,
    };
  } catch {
    return null;
  }
}
