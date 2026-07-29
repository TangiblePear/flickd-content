interface Env {
  BUCKET: R2Bucket;
  SHARE_TTL_SECONDS: string;
  MAX_ITEMS: string;
  RATE_LIMIT_PER_HOUR: string;
  FCM_PROJECT_ID: string;
  FCM_SERVICE_ACCOUNT_EMAIL: string;
  FCM_PRIVATE_KEY: string;
  // Image moderation. When MODERATION_ENABLED !== "true" or the key is absent,
  // uploads skip the paid scan (dev mode) and are accepted.
  MODERATION_ENABLED?: string;
  VISION_API_KEY?: string;
  // Distinct-reporter threshold that auto-hides a picture pending admin review.
  REPORT_AUTOHIDE?: string;
  // Orphan-profile reaper: delete a friendId folder untouched for this long.
  PROFILE_TTL_SECONDS?: string;
  // Retention for `_reports/` records. Nothing else prunes that prefix, so without
  // this it grows forever. Longer than a profile folder: a safety record should
  // outlive an inactive device.
  REPORT_TTL_SECONDS?: string;
  // Max folders the reaper purges per run (keeps each run bounded).
  GC_MAX_PREFIXES_PER_RUN?: string;
  // Opportunistic trigger cadence (no cron budget): run at most once per this.
  REAP_INTERVAL_SECONDS?: string;
  // Per-isolate throttle so we don't read the gate object on every request.
  REAP_GATE_THROTTLE_SECONDS?: string;
  // Google account linking (Part 1). GOOGLE_WEB_CLIENT_ID is the OAuth Web client
  // id the ID token's `aud` must match; ACCOUNT_PEPPER is a 32-byte secret used to
  // wrap the per-account DEK. Both absent → the account endpoints report not_configured.
  GOOGLE_WEB_CLIENT_ID?: string;
  ACCOUNT_PEPPER?: string;
  // Accounts/profiles/friendships/blocks. Bound in wrangler.toml as `DB`.
  DB: D1Database;
  // Workers AI, for inline comment translation. Optional: with no binding every
  // comment comes back flagged untranslated and the client falls back to
  // on-device ML Kit — the same path an exhausted daily allowance takes.
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  // Firebase project **id** (not the project number) — a Firebase ID token's
  // `aud`. Absent → /api/auth/* reports not_configured.
  FIREBASE_PROJECT_ID?: string;
  // Per-author hourly comment cap. Config rather than a constant so it tunes
  // without a deploy, the same shape as RATE_LIMIT_PER_HOUR.
  COMMENTS_PER_HOUR?: string;
  // GIF picker upstream. A SECRET (`wrangler secret put GIPHY_API_KEY`), never a
  // var, and never in the APK: the key is attached to a paid negotiated tier and
  // an APK key is trivially extractable. Unset ⇒ /api/giphy/* answers 503.
  GIPHY_API_KEY?: string;
  // Shared with the Pages admin panel, which proxies comment moderation here
  // rather than reaching into D1 itself. A SECRET:
  //   wrangler secret put ADMIN_KEY
  // Unset ⇒ /api/admin/* answers 403. Closed rather than open when unconfigured.
  ADMIN_KEY?: string;
}

import { sendFcmMessage, pickFcmTarget, FcmConfig } from "./fcm";
import { moderateImage } from "./moderation";
import { reapOrphanProfiles, reapOldReports, dueForReap } from "./reaper";
import { handleAccountLink, handleAccountResolve, handleAccountUnlink, deleteAccountForFriend } from "./account";
import { handleAuthSession, handleAuthLogout, resolveSession } from "./auth";
import { handleClearFeed, handleGetFeed, handlePublishFeed } from "./feed";
import {
  handleAcceptSharedList,
  handleDeleteSharedList,
  handleGetSharedLists,
  handleShareList,
} from "./lists";
import {
  handleDeleteMatch,
  handleGetMatchPayload,
  handleGetMatches,
  handleMatchAccept,
  handleMatchRequest,
} from "./match";
import {
  handleDeleteComment,
  handleGetComments,
  handleGetFriendComments,
  handlePostComment,
  handleReactToComment,
  handleReportComment,
  parseSubject,
} from "./comments";
import { handleGetPoll, handlePutVote } from "./poll";
import { handleAdminCommentAction, handleAdminCommentReports } from "./commentsAdmin";
import { handleGiphy } from "./giphy";
import { handleSync, type RelayRequest, type RelayResponse, type SyncEnv } from "./sync";
import {
  handleBlock,
  handleClaimFriendId,
  handleDeleteAccount,
  handleFriendAccept,
  handleFriendRemove,
  handleFriendRemoveByFriendId,
  handleFriendRequest,
  handleGetBlocks,
  handleGetFriendCards,
  handleGetFriends,
  handleLinkLegacyFriends,
  handleReport as handleUserReport,
  handleUnblock,
} from "./friends";
import type { PublicCard } from "./friends";
import {
  handleBootstrap,
  handleGetMyProfile,
  handleGetProfile,
  handlePutMyProfile,
  handlePutMyStats,
} from "./profiles";

interface ShareItem {
  tmdbId: number;
  type: string;
}

interface SharePayload {
  // "manual" carries an item snapshot; "smart" carries a filter blob the
  // recipient's app rebuilds into a dynamic smart list. Defaults to "manual"
  // so anything stored before this field existed still reads correctly.
  kind?: string;
  title: string;
  items?: ShareItem[];
  filters?: unknown;
}

interface StoredShare {
  kind: string;
  title: string;
  items: ShareItem[];
  filters: unknown | null;
  createdAt: string;
  expiresAt: string;
  /**
   * Taken down — by an admin, or automatically once enough distinct signed-in
   * reporters flagged it. Both read paths then answer **exactly** what an expired
   * link answers. That identity is the point: a takedown a user can distinguish
   * from an expiry is itself a signal, and tells an abuser their link was actioned.
   */
  hidden?: boolean;
  /**
   * The signed-in account that created this link, when there was one. `POST
   * /api/share` stays unauthenticated — that is the whole point of the path — so
   * this is null for anonymous shares and populated only when the caller happened
   * to send a session. It buys the admin a repeat offender to act on rather than
   * whack-a-mole with individual codes; it gates nothing.
   */
  creatorId?: string | null;
  /**
   * **Inert — never incremented, and nothing reads it.** Kept only so objects
   * written before 2026-07-27 still parse and the wire shape stays stable.
   *
   * `handleGet` used to read-modify-write this on every fetch: an R2 write on the
   * public path, and a lost update whenever two people opened the same link at once,
   * for a number no surface has ever displayed. **Do not reinstate the increment.**
   * If view counts are ever actually wanted, they belong in D1 as an atomic
   * `UPDATE … SET views = views + 1`, not as a read-modify-write against an object.
   */
  views: number;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, If-Match, X-Feed-Secret, X-Read-Token, X-Revoke-Session",
};

// ── Limits (the relay stores ciphertext only; these just cap abuse) ──
const MAX_BLOB_BYTES = 256 * 1024; // a profile / opinion ciphertext object
const MAX_ACCESS_BYTES = 512 * 1024; // wrapped-keys bundle (grows with friend count)
const MAX_BATCH_ITEMS = 200; // friends queried per opinion-batch call
const MAX_CARD_BYTES = 8 * 1024;
const MAX_FILTERS_BYTES = 4096;
const MAX_BACKUP_BYTES = 64 * 1024; // zero-knowledge identity bundle ciphertext
const MAX_SELF_BYTES = 512 * 1024; // live friends+block record ciphertext (grows with friend count)

const FRIENDCODE_TTL = 60 * 60 * 24 * 90; // 90 days
const FRIEND_ID = "[A-Z0-9]{12,40}";
const FRIEND_CODE = "[A-Z0-9]{6,12}";
const HASH = "[a-f0-9]{32,160}"; // hex blind index (HMAC-SHA256 + Tink prefix)
const LOOKUP_KEY = "[A-Za-z0-9_-]{22,128}"; // HKDF/HMAC blind index (hex or base64url)

const APP_PACKAGE = "com.flickto.app";
const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.flickto.app";
const APP_STORE_URL = "https://apps.apple.com/app/id0000000000";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...CORS, ...(init.headers ?? {}) },
  });

const rawJson = (raw: string) =>
  new Response(raw, { headers: { "Content-Type": "application/json", ...CORS } });

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    ...init,
    headers: { "Content-Type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });

const forbidden = () => json({ error: "forbidden" }, { status: 403 });
const notFound = () => json({ error: "not_found" }, { status: 404 });
const tooLarge = () => json({ error: "too_large" }, { status: 413 });
const invalidJson = () => json({ error: "invalid_json" }, { status: 400 });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Opportunistic orphan-profile reaper: no cron budget on this account, so we
    // let ambient request traffic tick the clock. Fire-and-forget — never blocks
    // the response, self-throttles, and runs the reap at most once per interval.
    ctx.waitUntil(maybeReap(env));

    const url = new URL(req.url);
    const p = url.pathname;

    // ── Share links (legacy feature, now R2-backed) ──
    if (p === "/api/share" && req.method === "POST") return handleCreate(req, env);

    const apiShare = p.match(/^\/api\/share\/([A-Z0-9]{6,12})$/);
    if (apiShare && req.method === "GET") return handleGet(apiShare[1], env);

    // Report a public share link. Needs no new route pattern — `/api/share/*` is
    // already bound in wrangler.toml. Unauthenticated by design; see the handler.
    const shareReport = p.match(/^\/api\/share\/([A-Z0-9]{6,12})\/report$/);
    if (shareReport && req.method === "POST") return handleShareReport(shareReport[1], req, env);

    const landing = p.match(/^\/share\/([A-Z0-9]{6,12})$/);
    if (landing && req.method === "GET") return handleLanding(landing[1], env);

    // ── Opinion batch (blind-indexed, on-demand reads) ──
    if (p === "/api/opinions/batch" && req.method === "POST") {
      return handleOpinionsBatch(req, env);
    }

    // ── User-scoped objects: access keys, profile, per-title opinions, push ──
    // `push` (was `fcm-token`) carries the owner's topic names for O(1) fan-out;
    // both are accepted during rollout and neither is client-readable (GET refused).
    const userObj = p.match(new RegExp(`^/api/user/(${FRIEND_ID})/(access|profile|fcm-token|push)$`));
    if (userObj) {
      const [, friendId, kind] = userObj;
      if (req.method === "PUT") return handlePutUserObject(friendId, kind, req, env, ctx);
      if (req.method === "GET" && kind !== "fcm-token" && kind !== "push") return handleGetUserObject(friendId, kind, req, env);
    }

    const userOpinion = p.match(new RegExp(`^/api/user/(${FRIEND_ID})/opinions/(${HASH})$`));
    if (userOpinion) {
      const [, friendId, hash] = userOpinion;
      if (req.method === "PUT") return handlePutOpinion(friendId, hash, req, env);
      if (req.method === "DELETE") return handleDeleteOpinion(friendId, hash, req, env);
    }

    // ── Profile picture (server-visible, moderated) ──
    const userPicture = p.match(new RegExp(`^/api/user/(${FRIEND_ID})/picture$`));
    if (userPicture) {
      const [, friendId] = userPicture;
      if (req.method === "PUT") return handlePutPicture(friendId, req, env, ctx);
      if (req.method === "GET") return handleGetPicture(friendId, env);
      if (req.method === "DELETE") return handleDeletePicture(friendId, req, env);
    }

    // ── Report ingestion (user / feed-comment / picture) → admin inbox ──
    const userReport = p.match(new RegExp(`^/api/user/(${FRIEND_ID})/report$`));
    if (userReport && req.method === "POST") return handleReport(userReport[1], req, env);

    // ── Freshness Check (Batch) ──
    if (p === "/api/social/freshness" && req.method === "POST") {
      return handleFreshness(req, env);
    }

    // ── Friend code → public friend card ──
    if (p === "/api/friendcode" && req.method === "POST") {
      return handlePublishFriendCode(req, env);
    }
    const friendCode = p.match(new RegExp(`^/api/friendcode/(${FRIEND_CODE})$`));
    if (friendCode && req.method === "GET") return handleGetFriendCode(friendCode[1], env);

    // Legal pages (/privacy, /delete) are now static HTML served by the
    // flickto-content worker — no route handlers needed here.

    // ── Portable identity backup (zero-knowledge ciphertext) ──
    if (p === "/api/social/backup" && req.method === "PUT") return handlePutBackup(req, env);
    const backupObj = p.match(new RegExp(`^/api/social/backup/(${LOOKUP_KEY})$`));
    if (backupObj) {
      if (req.method === "GET") return handleGetBackup(backupObj[1], env);
      if (req.method === "DELETE") return handleDeleteBackup(backupObj[1], env);
    }

    // ── Live friends+block record (optimistic concurrency) ──
    const selfObj = p.match(new RegExp(`^/api/social/self/(${LOOKUP_KEY})$`));
    if (selfObj) {
      if (req.method === "GET") return handleGetSelf(selfObj[1], env);
      if (req.method === "PUT") return handlePutSelf(selfObj[1], req, env);
      if (req.method === "DELETE") return handleDeleteSelf(selfObj[1], env);
    }

    // ── Google account linking (Part 1) ──
    if (p === "/api/account/link" && req.method === "POST") {
      return handleAccountLink(req, env, url, (friendId) => purgeFriendScoped(env, friendId));
    }
    if (p === "/api/account/resolve" && req.method === "GET") return handleAccountResolve(req, env);
    if (p === "/api/account/unlink" && req.method === "POST") return handleAccountUnlink(req, env);

    // ── Firebase Auth sessions (Phase 1) ──
    if (p === "/api/auth/session" && req.method === "POST") return handleAuthSession(req, env);
    if (p === "/api/auth/logout" && req.method === "POST") return handleAuthLogout(req, env);

    // ── Server-authoritative profiles (Phase 2). Session-authenticated. ──
    // NOT the same as /api/user/{friendId}/profile above, which is the E2EE
    // ciphertext blob and is staying — different auth, different data.
    if (p === "/api/me/bootstrap" && req.method === "GET") return handleBootstrap(req, env, ctx);
    if (p === "/api/me/profile") {
      if (req.method === "GET") return handleGetMyProfile(req, env, ctx);
      if (req.method === "PUT") return handlePutMyProfile(req, env, ctx);
    }
    if (p === "/api/me/stats" && req.method === "PUT") return handlePutMyStats(req, env, ctx);

    const foreignProfile = p.match(/^\/api\/profile\/([0-9A-HJKMNP-TV-Z]{26})$/);
    if (foreignProfile && req.method === "GET") return handleGetProfile(foreignProfile[1], req, env, ctx);

    // `wake` is fire-and-forget: ctx.waitUntil keeps the push alive past the response
    // without ever delaying or failing it.
    //
    // Declared HERE, above every consumer, not beside the lists/match routes it was
    // written for. `const` is not hoisted, so the friend-removal routes below --
    // added later and further up -- hit the temporal dead zone and threw
    // ReferenceError, which the catch-all turned into a 500. Every unfriend failed
    // server-side for ~40 minutes on 2026-07-28 while the client dutifully reported
    // "server delete failed: HTTP 500" into its own health log.
    const wake = (userId: string) => ctx.waitUntil(notifyAccount(env, userId));

    // ── Friendships, blocks, reports (Phase 3/4). Session-authenticated. ──
    if (p === "/api/me/friend-id" && req.method === "PUT") return handleClaimFriendId(req, env, ctx);
    if (p === "/api/me/account" && req.method === "DELETE") return handleDeleteAccount(req, env, ctx);
    if (p === "/api/friends" && req.method === "GET") return handleGetFriends(req, env, ctx);
    if (p === "/api/friends/request" && req.method === "POST") return handleFriendRequest(req, env, ctx, wake);
    if (p === "/api/friends/accept" && req.method === "POST") return handleFriendAccept(req, env, ctx, wake);
    if (p === "/api/friends/link-legacy" && req.method === "POST") return handleLinkLegacyFriends(req, env, ctx);
    if (p === "/api/friends/cards" && req.method === "POST") {
      return handleGetFriendCards(req, env, (friendId) => loadPublicCard(env, friendId), ctx);
    }

    const friendTarget = p.match(/^\/api\/friends\/([0-9A-HJKMNP-TV-Z]{26})$/);
    if (friendTarget && req.method === "DELETE") return handleFriendRemove(friendTarget[1], req, env, ctx, wake);
    // Its own path rather than an overload of the one above: a 26-character friendId
    // is a legal `users.id` too, so one route could not tell the two id spaces apart.
    const friendByDevice = p.match(/^\/api\/friends\/by-friend\/([A-Z0-9]{12,40})$/);
    if (friendByDevice && req.method === "DELETE") {
      return handleFriendRemoveByFriendId(friendByDevice[1], req, env, ctx, wake);
    }

    if (p === "/api/blocks" && req.method === "GET") return handleGetBlocks(req, env, ctx);
    const blockTarget = p.match(/^\/api\/blocks\/([0-9A-HJKMNP-TV-Z]{26})$/);
    if (blockTarget) {
      if (req.method === "POST") return handleBlock(blockTarget[1], req, env, ctx);
      if (req.method === "DELETE") return handleUnblock(blockTarget[1], req, env, ctx);
    }

    if (p === "/api/report" && req.method === "POST") return handleUserReport(req, env, ctx);

    // ── Shared lists + Friend Match (D1). Session-authenticated. ──
    // These replace the last two directed-message types on the E2EE inbox. Both
    // live in the D1 half deliberately — folding them into the relay would keep
    // alive the thing this work exists to retire.

    if (p === "/api/lists/share" && req.method === "POST") return handleShareList(req, env, ctx, wake);
    if (p === "/api/lists/shared" && req.method === "GET") return handleGetSharedLists(req, env, ctx);

    const listAccept = p.match(/^\/api\/lists\/shared\/([0-9A-HJKMNP-TV-Z]{8,40})\/accept$/);
    if (listAccept && req.method === "POST") return handleAcceptSharedList(listAccept[1], req, env, ctx);

    const listTarget = p.match(/^\/api\/lists\/shared\/([0-9A-HJKMNP-TV-Z]{8,40})$/);
    if (listTarget && req.method === "DELETE") return handleDeleteSharedList(listTarget[1], req, env, ctx);

    if (p === "/api/match" && req.method === "GET") return handleGetMatches(req, env, ctx);
    if (p === "/api/match/request" && req.method === "POST") {
      // The card resolver is injected because the friend card lives in R2 and
      // `match.ts` is deliberately D1-only — same reason `sync.ts` takes a RelayLoader.
      return handleMatchRequest(req, env, ctx, (code) => resolveCardOwner(env, code), wake);
    }

    const matchPayload = p.match(/^\/api\/match\/([0-9A-HJKMNP-TV-Z]{26})\/payload$/);
    if (matchPayload && req.method === "GET") return handleGetMatchPayload(matchPayload[1], req, env, ctx);

    const matchAccept = p.match(/^\/api\/match\/([0-9A-HJKMNP-TV-Z]{26})\/accept$/);
    if (matchAccept && req.method === "POST") return handleMatchAccept(matchAccept[1], req, env, ctx, wake);

    const matchTarget = p.match(/^\/api\/match\/([0-9A-HJKMNP-TV-Z]{26})$/);
    if (matchTarget && req.method === "DELETE") return handleDeleteMatch(matchTarget[1], req, env, ctx, wake);

    // ── One chargeable request per refresh (see src/sync.ts). ──
    // The relay half is injected here because the R2 object layout and its crypto
    // helpers live in this file; `sync.ts` stays D1-only and therefore testable.
    if (p === "/api/sync" && req.method === "POST") {
      return handleSync(req, env as unknown as SyncEnv, ctx, (_e, _uid, relayReq) => loadRelay(env, relayReq));
    }

    // ── Activity feed (Phase 6). Replaces the E2EE feed blob; opinions stay E2EE. ──
    if (p === "/api/feed" && req.method === "GET") return handleGetFeed(req, env, ctx);
    if (p === "/api/me/feed") {
      if (req.method === "POST") return handlePublishFeed(req, env, ctx);
      if (req.method === "DELETE") return handleClearFeed(req, env, ctx);
    }

    // ── Comments (D1). Two read paths, deliberately not one query. ──
    // Path 1 is unauthenticated and edge-cached; path 2 is authenticated and must
    // NEVER be cached, because `caches.default` keys on URL and would hand one
    // user's friends-only comments to the next reader of the same URL.
    const commentsSubject = p.match(/^\/api\/titles\/([a-z]+)\/(\d+)\/comments(\/friends)?$/);
    if (commentsSubject && req.method === "GET") {
      const subject = parseSubject(commentsSubject[1], commentsSubject[2], url.searchParams);
      if (!subject) return json({ error: "invalid_subject" }, { status: 400 });
      return commentsSubject[3]
        ? handleGetFriendComments(req, env, subject, ctx)
        : handleGetComments(req, env, subject, ctx);
    }

    // The episode poll rides the same `/api/titles/{type}/{id}/…` shape as comments so
    // both features agree on what a subject is — `parseSubject` is shared, not copied.
    // GET is unauthenticated and edge-cached; PUT is session-authed and writes.
    const pollSubject = p.match(/^\/api\/titles\/([a-z]+)\/(\d+)\/(poll|vote)$/);
    if (pollSubject) {
      const subject = parseSubject(pollSubject[1], pollSubject[2], url.searchParams);
      if (!subject) return json({ error: "invalid_subject" }, { status: 400 });
      if (pollSubject[3] === "poll" && req.method === "GET") return handleGetPoll(req, env, subject, ctx);
      if (pollSubject[3] === "vote" && req.method === "PUT") return handlePutVote(req, env, subject, ctx);
    }

    // One notifier for both comment paths. The collapse key is derived from the
    // KIND as well as the comment, so a "friend commented" notification and a
    // "people reacted" one about the same comment replace their own predecessors
    // rather than each other.
    const notifyComment = (userId: string, data: Record<string, string>) =>
      ctx.waitUntil(notifyAccount(env, userId, data, `${data.kind}:${data.commentId}`));

    if (p === "/api/comments" && req.method === "POST") return handlePostComment(req, env, ctx, notifyComment);

    const commentTarget = p.match(/^\/api\/comments\/([0-9A-Z:]{8,80})$/);
    if (commentTarget && req.method === "DELETE") return handleDeleteComment(commentTarget[1], req, env, ctx);

    const commentReaction = p.match(/^\/api\/comments\/([0-9A-Z:]{8,80})\/reaction$/);
    if (commentReaction && (req.method === "POST" || req.method === "DELETE")) {
      // The collapse key is the COMMENT, not the event: a later "12 people reacted"
      // must replace the earlier "8 people reacted" in the tray rather than sit
      // beside it saying a different number about the same thing.
      return handleReactToComment(commentReaction[1], req, env, ctx, notifyComment);
    }

    const commentReport = p.match(/^\/api\/comments\/([0-9A-Z:]{8,80})\/report$/);
    if (commentReport && req.method === "POST") return handleReportComment(commentReport[1], req, env, ctx);

    // ── GIF picker, proxied so the key never ships in the APK ──
    if (p === "/api/giphy/trending" && req.method === "GET") return handleGiphy("trending", req, env, ctx);
    if (p === "/api/giphy/search" && req.method === "GET") return handleGiphy("search", req, env, ctx);

    // Comment moderation, proxied here by the admin panel rather than reading D1
    // itself: `n_public` moves with `hidden_at`, and that invariant has exactly one
    // implementation. Authorized by a shared key, never a user session.
    if (p === "/api/moderation/comment-reports" && req.method === "GET") return handleAdminCommentReports(req, env);

    const adminComment = p.match(/^\/api\/moderation\/comments\/([0-9A-Z:]{8,80})\/([a-z]+)$/);
    if (adminComment && req.method === "POST") {
      return handleAdminCommentAction(adminComment[1], adminComment[2], req, env);
    }

    // ── Account / data deletion (Google Play deletion policy) ──
    if (p === "/api/social/delete" && req.method === "POST") return handleSocialDelete(req, env);
    if (p === "/api/social/delete-request" && req.method === "POST") return handleDeleteRequest(req, env);

    return notFound();
  },
};

// ── Opportunistic orphan-profile reaper ──────────────────────────────────────
// This account is at its 5-cron limit, so instead of a scheduled() cron the
// reaper piggybacks on ambient request traffic: any request past the interval
// fires one bounded reap in the background. A wiped/uninstalled device stops
// re-publishing (a live install re-PUTs fcm-token every ≤3 days), so its data
// ages out; recovery blobs (backup/, self/) are excluded by prefix shape.

interface GcState {
  cursor?: string;
  lastRunAt?: number;
}
const GC_CURSOR_KEY = "_gc/cursor.json";

// Best-effort per-isolate throttle so we hit R2 for the gate object at most once
// per window regardless of request volume (ephemeral; a recycled isolate just
// re-reads sooner — correctness rides on the persisted lastRunAt, not this).
let lastGateCheckMs = 0;

async function maybeReap(env: Env): Promise<void> {
  try {
    const now = Date.now();
    const throttleMs = Number(env.REAP_GATE_THROTTLE_SECONDS ?? "600") * 1000;
    if (now - lastGateCheckMs < throttleMs) return;
    lastGateCheckMs = now;

    const state = (await getJson<GcState>(env, GC_CURSOR_KEY)) ?? {};
    const intervalMs = Number(env.REAP_INTERVAL_SECONDS ?? "86400") * 1000; // default 24h
    if (!dueForReap(state.lastRunAt, now, intervalMs)) return;

    // Claim the run first so concurrent requests don't double-fire.
    await putJson(env, GC_CURSOR_KEY, { cursor: state.cursor, lastRunAt: now });
    await runReaper(env, state.cursor, now);
  } catch (e) {
    console.error("reaper: maybeReap failed", e);
  }
}

async function runReaper(env: Env, cursor: string | undefined, claimedAt: number): Promise<void> {
  const ttlMs = Number(env.PROFILE_TTL_SECONDS ?? "31536000") * 1000; // default 365d
  const cap = Number(env.GC_MAX_PREFIXES_PER_RUN ?? "500");
  const result = await reapOrphanProfiles(
    env.BUCKET,
    (friendId) => purgeFriendScoped(env, friendId),
    { nowMs: Date.now(), ttlMs, cap, cursor },
  );
  // Preserve the claim timestamp; advance the cursor for the next run.
  await putJson(env, GC_CURSOR_KEY, { cursor: result.nextCursor, lastRunAt: claimedAt });
  console.log(`reaper: purged ${result.reaped.length} orphan profile(s)`);

  // Retention hygiene for the moderation queue, which nothing else prunes. Its own
  // TTL, because a safety record should outlive an inactive profile folder.
  const reportTtlMs = Number(env.REPORT_TTL_SECONDS ?? "31536000") * 1000; // default 365d
  const dropped = await reapOldReports(
    env.BUCKET,
    (keys) => env.BUCKET.delete(keys),
    { nowMs: Date.now(), ttlMs: reportTtlMs, cap },
  );
  if (dropped.length) console.log(`reaper: pruned ${dropped.length} expired report(s)`);
}

// ── R2 helpers ─────────────────────────────────────────────────────────────

async function getText(env: Env, key: string): Promise<string | null> {
  const obj = await env.BUCKET.get(key);
  return obj ? await obj.text() : null;
}

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  try {
    return (await obj.json()) as T;
  } catch {
    return null;
  }
}

async function putJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.BUCKET.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function putRaw(env: Env, key: string, body: string): Promise<void> {
  await env.BUCKET.put(key, body, {
    httpMetadata: { contentType: "application/json" },
  });
}

// Lightweight per-IP hourly rate limit backed by R2 (one tiny object per
// ip+hour bucket; `rl/` should carry a 1-day lifecycle rule to self-clean).
async function rateLimited(env: Env, scope: string, ip: string, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const key = `rl/${scope}/${ip}/${currentHour()}.json`;
  const rec = await getJson<{ n: number }>(env, key);
  const count = rec?.n ?? 0;
  if (count >= limit) return true;
  await putJson(env, key, { n: count + 1 });
  return false;
}

function currentHour(): string {
  return new Date().toISOString().slice(0, 13);
}

// ── Auth: trust-on-first-use owner binding + read token ──────────────────────

/**
 * Owner binding for a friendId. `h` = sha256(writeSecret).
 * Read tokens are split (0a-3) so un-friending can revoke without a bootstrap
 * deadlock: `ta` is stable and gates `access.json` only; `tc` is rotatable and
 * gates `profile.json` + `opinions/*`. `t` is the legacy single token (pre-0a-3),
 * read as both when `ta`/`tc` are absent.
 */
interface OwnerRecord {
  h: string;
  t?: string;
  ta?: string;
  tc?: string;
}

/** Effective stable (access) read token, honouring the legacy single token. */
const effTa = (rec: OwnerRecord): string | undefined => rec.ta ?? rec.t;
/**
 * Effective rotatable (profile/opinions) read token. Falls back to the legacy
 * single token, then to `ta`, so an author who bound only `ta` (a pre-0a-3 client
 * against this worker) is still readable during rollout. A real 0a-3 author always
 * binds `tc`, so this fallback never weakens their rotation-based revocation.
 */
const effTc = (rec: OwnerRecord): string | undefined => rec.tc ?? rec.t ?? rec.ta;

const ownerKey = (friendId: string) => `${friendId}/owner.json`;

/**
 * Owner-auth result. `created` is true when this call had to freshly create
 * `owner.json` (trust-on-first-use) — the signal that the relay had lost this
 * identity's data (e.g. reaped after inactivity), so the client should re-publish.
 */
interface OwnerAuth {
  ok: boolean;
  created: boolean;
}

/** Owner-authenticate a write. Binds the secret on first use; verifies after. */
async function verifyOwner(env: Env, friendId: string, secret: string | null): Promise<OwnerAuth> {
  if (!secret) return { ok: false, created: false };
  const hash = await sha256hex(secret);
  const existing = await getJson<OwnerRecord>(env, ownerKey(friendId));
  if (!existing) {
    await putJson(env, ownerKey(friendId), { h: hash });
    return { ok: true, created: true };
  }
  return { ok: existing.h === hash, created: false };
}

/**
 * Owner-authenticate AND (re)bind the read tokens friends present to read.
 * `ta` gates access.json (stable); `tc` gates profile/opinions (rotatable). Each
 * absent value preserves what was bound before, so a write that carries only one
 * token never clears the other. Rotation is just a write that supplies a new `tc`.
 */
async function verifyOwnerBindToken(
  env: Env,
  friendId: string,
  secret: string | null,
  ta: string | null,
  tc: string | null,
): Promise<OwnerAuth> {
  if (!secret) return { ok: false, created: false };
  const hash = await sha256hex(secret);
  const existing = await getJson<OwnerRecord>(env, ownerKey(friendId));
  if (existing && existing.h !== hash) return { ok: false, created: false };
  const next: OwnerRecord = {
    h: hash,
    ta: ta ?? (existing ? effTa(existing) : undefined),
    tc: tc ?? (existing ? effTc(existing) : undefined),
  };
  if (!existing || existing.h !== next.h || existing.ta !== next.ta || existing.tc !== next.tc) {
    await putJson(env, ownerKey(friendId), next);
  }
  return { ok: true, created: !existing };
}

/**
 * Read-gate: the presented token must match the author's bound read token for the
 * given slot — `"a"` for access.json (stable `ta`), `"c"` for profile/opinions
 * (rotatable `tc`). A rotated `tc` therefore 403s a stale reader immediately.
 */
async function verifyReadToken(
  env: Env,
  friendId: string,
  token: string | null,
  which: "a" | "c",
): Promise<boolean> {
  if (!token) return false;
  const rec = await getJson<OwnerRecord>(env, ownerKey(friendId));
  if (!rec) return false;
  const bound = which === "a" ? effTa(rec) : effTc(rec);
  return !!bound && bound === token;
}

// ── Social handlers ──────────────────────────────────────────────────────────

/**
 * The etag a client read back from a GET, in the form `onlyIf.etagMatches` wants:
 * bare hex, no `W/` prefix and no quotes.
 *
 * Both wrappers have to go, and for different reasons. Cloudflare rewrites strong
 * etags to weak ones (`W/"…"`) on the way out through the CDN, so the value a
 * client echoes back never equals the strong etag R2 compares against. And R2
 * *throws* on a quoted value rather than simply not matching it — even though the
 * quoted form is exactly what `httpEtag` hands back. Passing the header through
 * verbatim therefore fails 100% of the time: it 409'd on the weak form, and
 * 500'd once the prefix alone was stripped.
 *
 * Clients in the field send the weak quoted form and cannot be fixed
 * retroactively, so the normalisation belongs here.
 */
function strongEtag(value: string | null): string | null {
  const v = value?.trim().replace(/^W\//, "").replace(/"/g, "");
  return v ? v : null;
}

// PUT access.json / profile.json — owner-auth + bind read token. Body is opaque.
async function handlePutUserObject(
  friendId: string,
  kind: string,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // X-Read-Token = stable `ta` (access); X-Read-Token-C = rotatable `tc`
  // (profile/opinions). Each write rebinds whichever it carries; rotation is just a
  // write with a new tc. Access writes rate-limited so churn can't hammer the relay.
  const ta = req.headers.get("X-Read-Token");
  const tc = req.headers.get("X-Read-Token-C");
  if (kind === "access") {
    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
    if (await rateLimited(env, "access", ip, Number(env.RATE_LIMIT_PER_HOUR ?? "10") * 6)) {
      return json({ error: "rate_limited" }, { status: 429 });
    }
  }
  const owner = await verifyOwnerBindToken(env, friendId, req.headers.get("X-Feed-Secret"), ta, tc);
  if (!owner.ok) return forbidden();
  const body = await req.text();
  let cap = MAX_BLOB_BYTES;
  if (kind === "access") cap = MAX_ACCESS_BYTES;
  if (kind === "fcm-token" || kind === "push") cap = 2048;
  if (body.length > cap) return tooLarge();
  try {
    JSON.parse(body);
  } catch {
    return invalidJson();
  }
  if (kind === "profile") {
    // Stash the rotatable read token (tc) on the object so freshness can authorize
    // with a single get() (0a-2). Profile is re-PUT on rotation, so this stays
    // current — unlike opinions, whose batch endpoint checks owner.json.tc directly.
    const putOpts: R2PutOptions = {
      httpMetadata: { contentType: "application/json" },
      ...(tc ? { customMetadata: { rt: tc } } : {}),
    };
    // Read-merge-write concurrency (0c-2): when the client sends the etag it merged
    // against (X-If-Match), do a conditional put so two devices can't lose one
    // another's merge. A mismatch (or a since-deleted object) returns 409 + the
    // current etag; the client re-reads, re-merges and retries once.
    const ifMatch = strongEtag(req.headers.get("X-If-Match"));
    if (ifMatch) {
      const written = await env.BUCKET.put(`${friendId}/${kind}.json`, body, {
        ...putOpts,
        onlyIf: { etagMatches: ifMatch },
      });
      if (written === null) {
        const head = await env.BUCKET.head(`${friendId}/${kind}.json`);
        return json({ error: "etag_conflict", etag: head?.httpEtag }, { status: 409 });
      }
      ctx.waitUntil(fanOutProfileUpdate(friendId, env));
      return json({ ok: true, ownerRecreated: owner.created, etag: written.httpEtag });
    }
    const written = await env.BUCKET.put(`${friendId}/${kind}.json`, body, putOpts);
    ctx.waitUntil(fanOutProfileUpdate(friendId, env));
    return json({ ok: true, ownerRecreated: owner.created, etag: written?.httpEtag });
  }

  await putRaw(env, `${friendId}/${kind}.json`, body);
  return json({ ok: true, ownerRecreated: owner.created });
}

interface PushRecord {
  selfTopic?: string;
  friendTopic?: string;
  token?: string;
}

/** Read an owner's push record, preferring `push.json` over the legacy `fcm-token.json`. */
async function readPushRecord(env: Env, friendId: string): Promise<PushRecord | null> {
  const raw = (await getText(env, `${friendId}/push.json`)) ?? (await getText(env, `${friendId}/fcm-token.json`));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PushRecord;
  } catch {
    return null;
  }
}

function fcmConfig(env: Env): FcmConfig | null {
  if (!env.FCM_PROJECT_ID || !env.FCM_SERVICE_ACCOUNT_EMAIL || !env.FCM_PRIVATE_KEY) return null;
  return {
    projectId: env.FCM_PROJECT_ID,
    clientEmail: env.FCM_SERVICE_ACCOUNT_EMAIL,
    privateKey: env.FCM_PRIVATE_KEY,
  };
}

// Ambient profile fan-out. With push topics this is O(1): publish one message to
// the owner's friend-topic and Google delivers it to every subscribed friend on
// every device. Only a pre-topics owner (no `friendTopic` yet) falls back to the
// legacy per-friend token loop, which self-resolves once the owner republishes
// `push.json` within the client's ~3-day heartbeat.
async function fanOutProfileUpdate(myId: string, env: Env) {
  const config = fcmConfig(env);
  if (!config) return;
  try {
    const mine = await readPushRecord(env, myId);
    if (mine && typeof mine.friendTopic === "string" && mine.friendTopic) {
      const target = pickFcmTarget(mine, "friend");
      if (target && "topic" in target) {
        await sendFcmMessage(config, target, myId, "social_update");
        return;
      }
    }
    // Legacy fallback: owner not yet on topics — notify each friend's device token.
    const accessStr = await getText(env, `${myId}/access.json`);
    if (!accessStr) return;
    const access = JSON.parse(accessStr) as { keys?: Record<string, unknown> };
    if (!access.keys) return;
    for (const friendId of Object.keys(access.keys)) {
      const rec = await readPushRecord(env, friendId);
      if (rec && typeof rec.token === "string" && rec.token) {
        await sendFcmMessage(config, { token: rec.token }, myId, "social_update");
      }
    }
  } catch (e) {
    console.error("Failed to fan out profile update", e);
  }
}

// GET access.json / profile.json — read-token-gated; returns stored ciphertext.
async function handleGetUserObject(
  friendId: string,
  kind: string,
  req: Request,
  env: Env,
): Promise<Response> {
  // access.json is gated by the stable `ta`; profile.json by the rotatable `tc`.
  const which = kind === "access" ? "a" : "c";
  if (!(await verifyReadToken(env, friendId, req.headers.get("X-Read-Token"), which))) return forbidden();
  // get() (not getText) so we can surface the ETag — the owner's read-merge-write
  // sends it back as X-If-Match for the conditional profile write (0c-2).
  const obj = await env.BUCKET.get(`${friendId}/${kind}.json`);
  if (!obj) return notFound();
  const raw = await obj.text();
  return new Response(raw, {
    headers: {
      "Content-Type": "application/json",
      ...CORS,
      "Access-Control-Expose-Headers": "ETag",
      ETag: obj.httpEtag,
    },
  });
}

// PUT one encrypted opinion, located by its blind index hash. Owner-auth.
async function handlePutOpinion(friendId: string, hash: string, req: Request, env: Env): Promise<Response> {
  const auth = await verifyOwner(env, friendId, req.headers.get("X-Feed-Secret"));
  if (!auth.ok) return forbidden();
  const body = await req.text();
  if (body.length > MAX_BLOB_BYTES) return tooLarge();
  try {
    JSON.parse(body);
  } catch {
    return invalidJson();
  }
  // Stash the read token so the batch endpoint can authorize with one get() (0a-2).
  const readToken = req.headers.get("X-Read-Token");
  await env.BUCKET.put(`${friendId}/opinions/${hash}.json`, body, {
    httpMetadata: { contentType: "application/json" },
    ...(readToken ? { customMetadata: { rt: readToken } } : {}),
  });
  return json({ ok: true, ownerRecreated: auth.created });
}

// DELETE one opinion (true removal on tombstone). Owner-auth.
async function handleDeleteOpinion(friendId: string, hash: string, req: Request, env: Env): Promise<Response> {
  const auth = await verifyOwner(env, friendId, req.headers.get("X-Feed-Secret"));
  if (!auth.ok) return forbidden();
  await env.BUCKET.delete(`${friendId}/opinions/${hash}.json`);
  return json({ ok: true, ownerRecreated: auth.created });
}

// ── Profile pictures + reports ──────────────────────────────────────────────
// All picture-domain objects live in the social bucket alongside E2EE user data
// so the flickto-web admin panel can bind the same bucket for review/takedown:
//   pics/{friendId}/picture.jpg           — the image bytes
//   pics/{friendId}/meta.json             — { version, contentType, sha256, verdict }
//   _moderation/{friendId}.json           — takedown tombstone (auto or admin)
//   _reports/{targetId}/{ts}-{reporter}.json — one report record
const MAX_PICTURE_BYTES = 512 * 1024;
const picKey = (friendId: string) => `${friendId}/pics/picture.jpg`;
const picMetaKey = (friendId: string) => `${friendId}/pics/meta.json`;
const tombstoneKey = (friendId: string) => `_moderation/${friendId}.json`;
const REPORT_KINDS = new Set(["user", "feed_comment", "picture"]);
/**
 * Report kind for a public `share/{code}` link. Deliberately NOT in [REPORT_KINDS]:
 * that set gates `/api/user/{friendId}/report`, whose target is a friendId, and a
 * share code is not one. Share reports have their own route and their own target
 * namespace under the same `_reports/` prefix.
 */
const KIND_SHARED_LIST = "shared_list";

interface PictureMeta {
  version: number;
  contentType: string;
  sha256: string;
  verdict: string;
  updatedAt: number;
}

/** Sniff the leading bytes for a supported raster type. Returns a MIME or null. */
function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) return "image/webp";
  return null;
}

// PUT the owner's profile picture. Owner-auth (same secret + read token that
// gates profile.json). Scans the bytes before storing; a flagged image is never
// persisted or shared. A fresh upload clears any prior takedown tombstone.
async function handlePutPicture(
  friendId: string,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const owner = await verifyOwnerBindToken(env, friendId, req.headers.get("X-Feed-Secret"), req.headers.get("X-Read-Token"), req.headers.get("X-Read-Token-C"));
  if (!owner.ok) return forbidden();
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength === 0) return invalidJson();
  if (buf.byteLength > MAX_PICTURE_BYTES) return tooLarge();

  const contentType = sniffImageType(buf);
  if (!contentType) return json({ error: "unsupported_type" }, { status: 400 });

  const result = await moderateImage(buf, env);
  if (!result.allowed) {
    return json({ error: "rejected", categories: result.categories }, { status: 422 });
  }

  const version = Date.now();
  await env.BUCKET.put(picKey(friendId), buf, { httpMetadata: { contentType } });
  const meta: PictureMeta = {
    version,
    contentType,
    sha256: await sha256hexBytes(buf),
    verdict: result.verdict,
    updatedAt: version,
  };
  await env.BUCKET.put(picMetaKey(friendId), JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
  });
  // A new image supersedes any earlier auto/admin takedown.
  await env.BUCKET.delete(tombstoneKey(friendId));

  // Reuse the profile fan-out so friends refresh and pull the new pictureUrl.
  ctx.waitUntil(fanOutProfileUpdate(friendId, env));

  const url = `https://flickto.app/api/user/${friendId}/picture?v=${version}`;
  return json({ ok: true, url, version, ownerRecreated: owner.created });
}

// GET a profile picture. Public — the opaque friendId is the capability, so Coil
// loads it with no custom headers. A takedown tombstone yields 410.
async function handleGetPicture(friendId: string, env: Env): Promise<Response> {
  const tomb = await env.BUCKET.get(tombstoneKey(friendId));
  if (tomb) return new Response("gone", { status: 410, headers: { ...CORS } });
  const obj = await env.BUCKET.get(picKey(friendId));
  if (!obj) return new Response("not found", { status: 404, headers: { ...CORS } });
  const contentType = obj.httpMetadata?.contentType ?? "image/jpeg";
  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      ...CORS,
    },
  });
}

// DELETE the owner's own picture. Owner-auth.
async function handleDeletePicture(friendId: string, req: Request, env: Env): Promise<Response> {
  const auth = await verifyOwner(env, friendId, req.headers.get("X-Feed-Secret"));
  if (!auth.ok) return forbidden();
  await env.BUCKET.delete(picKey(friendId));
  await env.BUCKET.delete(picMetaKey(friendId));
  return json({ ok: true, ownerRecreated: auth.created });
}

// POST a report for any content kind. The reporter proves a real identity by
// presenting their own bound read token (X-Read-Token matching reporterId). The
// record lands in the admin Reports inbox; picture reports auto-hide at threshold.
async function handleReport(targetFriendId: string, req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = Number(env.RATE_LIMIT_PER_HOUR ?? "10");
  if (await rateLimited(env, "report", ip, limit)) return json({ error: "rate_limited" }, { status: 429 });

  let body: { kind?: unknown; reporterId?: unknown; reason?: unknown; context?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return invalidJson();
  }
  const kind = typeof body.kind === "string" ? body.kind : "";
  const reporterId = typeof body.reporterId === "string" ? body.reporterId : "";
  if (!REPORT_KINDS.has(kind) || !reporterId) return json({ error: "bad_request" }, { status: 400 });

  // Anti-spam: the reporter must own the reporterId (its bound read token).
  if (!(await verifyReadToken(env, reporterId, req.headers.get("X-Read-Token"), "a"))) return forbidden();

  const record = {
    kind,
    targetFriendId,
    reporterId,
    reason: typeof body.reason === "string" ? body.reason.slice(0, 2000) : "",
    context: typeof body.context === "string" ? body.context.slice(0, 4000) : "",
    at: Date.now(),
    resolved: false,
  };
  await env.BUCKET.put(
    `_reports/${targetFriendId}/${record.at}-${reporterId}.json`,
    JSON.stringify(record),
    { httpMetadata: { contentType: "application/json" } },
  );

  // Picture reports auto-hide once enough distinct reporters flag them.
  if (kind === "picture") {
    const threshold = Number(env.REPORT_AUTOHIDE ?? "3");
    const listed = await env.BUCKET.list({ prefix: `_reports/${targetFriendId}/` });
    const reporters = new Set<string>();
    for (const o of listed.objects) {
      const name = o.key.split("/").pop() ?? "";
      const who = name.replace(/\.json$/, "").split("-").slice(1).join("-");
      if (who) reporters.add(who);
    }
    if (reporters.size >= threshold) {
      await env.BUCKET.put(
        tombstoneKey(targetFriendId),
        JSON.stringify({ reason: "auto_report_threshold", at: Date.now() }),
        { httpMetadata: { contentType: "application/json" } },
      );
    }
  }

  return json({ ok: true });
}

/**
 * Resolve a session **without requiring one**. Returns the account id, or null for
 * an absent, malformed or expired token — never throws and never 401s.
 *
 * Used by the two share-link paths that are open to the whole internet: creating a
 * link (which stamps `creatorId` when it can) and reporting one (where a session
 * upgrades the report from "queue for review" to "counts toward autohide").
 */
async function runOptionalSession(req: Request, env: Env): Promise<string | null> {
  if (!req.headers.get("Authorization")) return null;
  try {
    const session = await resolveSession(req, env as any);
    return session?.userId ?? null;
  } catch {
    return null;
  }
}

/** Marker reporter id for a report filed with no session. Never counted (see below). */
const ANON_REPORTER = "anon";

/**
 * `POST /api/share/{code}/report` — report a public share link.
 *
 * **Deliberately open to anonymous callers.** The landing page is served to anyone,
 * and the people most likely to see an abusive link were sent it in a group chat and
 * have no account at all. Gating on sign-in would leave the main audience with no
 * route, so this answers 204 (or 429) and never 401.
 *
 * That makes it a spam target, so an anonymous report **cannot hide anything**:
 *
 * - every report lands in the admin queue (`_reports/`, the same prefix and record
 *   shape the picture reports use, so the existing admin listing shows it unchanged);
 * - only **distinct signed-in reporters** count toward [Env.REPORT_AUTOHIDE], so an
 *   anonymous flood summons a human rather than performing a takedown;
 * - anonymous callers are rate-limited per IP by the same helper `handleCreate` uses.
 *
 * A report against an unknown or already-expired code is a silent no-op, not a 404:
 * answering differently would turn this into a probe for which codes exist.
 */
async function handleShareReport(code: string, req: Request, env: Env): Promise<Response> {
  const reporter = await runOptionalSession(req, env);
  if (!reporter) {
    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
    const limit = Number(env.RATE_LIMIT_PER_HOUR ?? "10");
    if (await rateLimited(env, "sharereport", ip, limit)) {
      return json({ error: "rate_limited" }, { status: 429 });
    }
  }

  let body: { reason?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // A bodyless report is fine — the reason is optional.
  }

  const stored = await getJson<StoredShare>(env, `share/${code}.json`);
  if (!stored) return new Response(null, { status: 204, headers: CORS });

  const at = Date.now();
  const reporterId = reporter ?? ANON_REPORTER;
  await putJson(env, `_reports/${code}/${at}-${reporterId}.json`, {
    kind: KIND_SHARED_LIST,
    targetFriendId: code,
    reporterId,
    reason: typeof body.reason === "string" ? body.reason.slice(0, 2000) : "",
    context: stored.title,
    at,
    resolved: false,
  });

  // Only a signed-in reporter can move the counter. An unauthenticated POST that
  // could hide a link would let anyone take down any link by volume — this is the
  // property that stops the open endpoint becoming a takedown weapon.
  if (reporter && !stored.hidden) {
    const threshold = Number(env.REPORT_AUTOHIDE ?? "3");
    if ((await distinctAuthenticatedReporters(env, code)) >= threshold) {
      await putJson(env, `share/${code}.json`, { ...stored, hidden: true });
    }
  }

  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Distinct signed-in reporters against one target, from the `_reports/` filenames —
 * the same `{at}-{reporter}` layout and the same parse the picture autohide uses.
 * [ANON_REPORTER] is excluded, which is what keeps anonymous reports advisory.
 */
async function distinctAuthenticatedReporters(env: Env, target: string): Promise<number> {
  const listed = await env.BUCKET.list({ prefix: `_reports/${target}/` });
  const reporters = new Set<string>();
  for (const o of listed.objects) {
    const name = o.key.split("/").pop() ?? "";
    const who = name.replace(/\.json$/, "").split("-").slice(1).join("-");
    if (who && who !== ANON_REPORTER) reporters.add(who);
  }
  return reporters.size;
}

/** sha256 hex over raw bytes (the string variant hashes UTF-8 text). */
async function sha256hexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface BatchQuery {
  friendId?: unknown;
  hash?: unknown;
  readToken?: unknown;
}
interface OpinionFile {
  ciphertext?: unknown;
}

// Fetch many friends' opinions for one title in a single call. Each entry is
// read-token-gated; the blind hash differs per author, so callers send one per
// friend. The relay never learns the tmdbId (only opaque hashes).
async function handleOpinionsBatch(req: Request, env: Env): Promise<Response> {
  let body: { items?: unknown };
  try {
    body = (await req.json()) as { items?: unknown };
  } catch {
    return invalidJson();
  }
  const items = Array.isArray(body.items) ? (body.items as BatchQuery[]) : null;
  if (!items) return json({ error: "invalid_payload" }, { status: 400 });

  const out: Array<{ friendId: string; hash: string; ciphertext: string }> = [];
  for (const it of items.slice(0, MAX_BATCH_ITEMS)) {
    const friendId = typeof it.friendId === "string" ? it.friendId : "";
    const hash = typeof it.hash === "string" ? it.hash : "";
    const readToken = typeof it.readToken === "string" ? it.readToken : "";
    if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) continue;
    if (!new RegExp(`^${HASH}$`).test(hash)) continue;
    // Opinions are gated by the live rotatable `tc` (owner.json), NOT the token
    // stamped on the object: opinion objects are not re-PUT on rotation, so their
    // customMetadata goes stale — a removed friend's revoked tc must still 403 here
    // (0a-3). That is one owner.json read + one object read per friend; the client
    // chunks the batch so a request never approaches the 50-subrequest cap.
    if (!(await verifyReadToken(env, friendId, readToken, "c"))) continue;
    const obj = await env.BUCKET.get(`${friendId}/opinions/${hash}.json`);
    if (!obj) continue;
    try {
      const file = (await obj.json()) as OpinionFile;
      if (file && typeof file.ciphertext === "string") {
        out.push({ friendId, hash, ciphertext: file.ciphertext });
      }
    } catch {
      // skip malformed
    }
  }
  return json({ items: out });
}




// Keep an acked item this long so a device offline for a few days still learns the
// ack (and dismisses its own copy) rather than re-showing a resolved request.
// Unacked items expire here — nobody ever actioned them.







interface FreshnessQuery {
  friendId?: unknown;
  readToken?: unknown;
  since?: unknown;
  keyEpoch?: unknown;
}

/**
 * The R2 half of `POST /api/sync`: the batched freshness scan plus this device's
 * inbox, in the same inbound request as the D1 reads.
 *
 * Authorization is unchanged and still per-object — the freshness scan checks each
 * author's rotatable read token, and the inbox needs the owner's own secret. Holding
 * a session grants nothing here; a caller who omits `feedSecret` simply gets no
 * inbox back rather than an error, because the relay half is optional by design.
 */
async function loadRelay(env: Env, relay: RelayRequest): Promise<RelayResponse> {
  const requesterId =
    typeof relay.requesterId === "string" && new RegExp(`^${FRIEND_ID}$`).test(relay.requesterId)
      ? relay.requesterId
      : "";
  const queries = (relay.friends ?? []) as FreshnessQuery[];

  // Both in parallel: they touch different objects and neither depends on the other,
  // so the request costs one round trip's worth of latency rather than two.
  const [freshness, self] = await Promise.all([
    queries.length ? freshnessItems(env, queries, requesterId) : Promise.resolve([]),
    relay.selfLookupKey && new RegExp(`^${LOOKUP_KEY}$`).test(relay.selfLookupKey)
      ? getJson<SelfRecord>(env, `self/${relay.selfLookupKey}.json`).then((r) =>
          r ? { ciphertext: r.ciphertext, version: r.version } : null,
        )
      : Promise.resolve(null),
  ]);
  return { freshness, self };
}


/** Blind index of a friendId for access.json slots — matches the client's derivation. */
async function accessSlotHash(friendId: string): Promise<string> {
  return sha256hex(`access-slot:${friendId}`);
}

async function handleFreshness(req: Request, env: Env): Promise<Response> {
  let body: { items?: unknown; requesterId?: unknown };
  try {
    body = (await req.json()) as { items?: unknown; requesterId?: unknown };
  } catch {
    return invalidJson();
  }
  const items = Array.isArray(body.items) ? (body.items as FreshnessQuery[]) : null;
  if (!items) return json({ error: "invalid_payload" }, { status: 400 });

  // The caller's own friendId — lets us return their freshly-sealed access slot
  // inline when an author rotated (0a-3), so they re-key without an extra request.
  const requesterId =
    typeof body.requesterId === "string" && new RegExp(`^${FRIEND_ID}$`).test(body.requesterId)
      ? body.requesterId
      : "";
  return json({ items: await freshnessItems(env, items, requesterId) });
}

/**
 * The freshness scan itself, split out of [handleFreshness] so `POST /api/sync` can
 * fold it into the same request as the D1 reads. Subrequests are free; the inbound
 * request is what Cloudflare bills.
 */
async function freshnessItems(env: Env, items: FreshnessQuery[], requesterId: string) {
  const slotHash = requesterId ? await accessSlotHash(requesterId) : "";

  const out: Array<{ friendId: string; modifiedAt: number; profile?: unknown; slot?: unknown; keyEpoch?: number }> = [];
  for (const it of items.slice(0, MAX_BATCH_ITEMS)) {
    const friendId = typeof it.friendId === "string" ? it.friendId : "";
    const readToken = typeof it.readToken === "string" ? it.readToken : "";
    const since = typeof it.since === "number" ? it.since : 0;
    const sentEpoch = typeof it.keyEpoch === "number" ? it.keyEpoch : 0;

    if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) continue;

    // Single get() yields body + uploaded + customMetadata — no separate owner.json
    // read or head() (0a-2). The plaintext header carries the author's keyEpoch.
    const obj = await env.BUCKET.get(`${friendId}/profile.json`);
    if (!obj) continue;
    const uploaded = obj.uploaded.getTime();
    let profile: any = null;
    try {
      profile = await obj.json();
    } catch {
      profile = null;
    }
    const authorEpoch =
      profile && profile.header && typeof profile.header.keyEpoch === "number" ? profile.header.keyEpoch : 0;

    // Rotation: the author bumped keyEpoch since the requester last synced. Return
    // the requester's re-sealed access slot inline so they pick up the new feed key,
    // tc, and topic in this same call. Membership in access.json is the authorization
    // (the slot is sealed to their public keyset); a removed friend has no slot and
    // receives nothing here — actually revoked.
    if (slotHash && authorEpoch > sentEpoch) {
      const access = await getJson<{ keys?: Record<string, unknown> }>(env, `${friendId}/access.json`);
      const slot = access?.keys?.[slotHash];
      if (slot !== undefined && profile) {
        out.push({ friendId, modifiedAt: uploaded, profile, slot, keyEpoch: authorEpoch });
      }
      continue;
    }

    // Normal path: fresh + authorized by the rotatable tc (customMetadata, or the
    // live owner.json for a profile written before the token was stamped).
    if (uploaded <= since) continue;
    const rt = obj.customMetadata?.rt;
    const authed = rt ? rt === readToken : await verifyReadToken(env, friendId, readToken, "c");
    if (!authed) continue;
    out.push({ friendId, modifiedAt: uploaded, profile: profile ?? undefined });
  }
  return out;
}

interface FcOwnerRecord {
  c: string;
}

// Publish my public friend card under a short, stable code (owner-authenticated).
// The card holds only public pairing info — no secrets.
async function handlePublishFriendCode(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (body.length > MAX_CARD_BYTES) return tooLarge();
  let card: { friendId?: unknown };
  try {
    card = JSON.parse(body);
  } catch {
    return invalidJson();
  }
  const friendId = typeof card.friendId === "string" ? card.friendId : "";
  if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) return json({ error: "invalid_card" }, { status: 400 });
  const auth = await verifyOwner(env, friendId, req.headers.get("X-Feed-Secret"));
  if (!auth.ok) return forbidden();

  // Stable code per friendId: reuse the existing one, else mint a unique one.
  const owner = await getJson<FcOwnerRecord>(env, `${friendId}/friendcode.json`);
  const code = owner?.c ?? (await generateUniqueFriendCode(env));
  const existingCard = await getText(env, `fc/${code}.json`);
  if (existingCard !== body) {
    await putRaw(env, `fc/${code}.json`, body);
    await putJson(env, `${friendId}/friendcode.json`, { c: code });
  }
  return json({
    code,
    expiresAt: new Date(Date.now() + FRIENDCODE_TTL * 1000).toISOString(),
    ownerRecreated: auth.created,
  });
}

async function handleGetFriendCode(code: string, env: Env): Promise<Response> {
  const raw = await getText(env, `fc/${code}.json`);
  return raw ? rawJson(raw) : notFound();
}

/**
 * The public card a device published, by its friendId — the R2 half of
 * `POST /api/friends/cards`.
 *
 * Two gets, because cards are stored under the *code* (which is what a scanner
 * has) and the pointer from friendId to code lives beside the owner's other
 * objects. Callers are edge-gated and capped, so this never fans out far enough
 * to matter against the subrequest budget.
 *
 * Returns only the pairing fields. The stored card is client-written, so nothing
 * here may be trusted beyond being public — `handleGetFriendCards` re-checks the
 * friendId against the claim-checked `users.friend_id`.
 */
async function loadPublicCard(env: Env, friendId: string): Promise<PublicCard | null> {
  const owner = await getJson<FcOwnerRecord>(env, `${friendId}/friendcode.json`);
  if (!owner?.c) return null;
  const card = await getJson<Record<string, unknown>>(env, `fc/${owner.c}.json`);
  if (!card || typeof card.friendId !== "string" || typeof card.publicKeyset !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    friendId: card.friendId,
    publicKeyset: card.publicKeyset,
    feedReadToken: str(card.feedReadToken),
    displayName: str(card.displayName),
    avatarId: str(card.avatarId),
    borderId: str(card.borderId),
    pictureUrl: str(card.pictureUrl),
  };
}

/**
 * The account that published friend card [code], or null.
 *
 * Injected into `POST /api/match/request` so a stranger match can be gated on
 * having actually seen someone's code. **This is spam control, not a proximity
 * proof** — the same card is published under the shareable friend code that goes
 * in invite links, so holding it says nothing about being in the room. What makes
 * the stranger path safe is the exchange order, not this check.
 */
/**
 * Wake every device belonging to account [userId] so it syncs immediately.
 *
 * The D1 half of this Worker knows accounts (`users.id`); push topics are keyed by
 * the **device friendId** and the record lives in R2. This bridges the two, which is
 * why it lives here and is injected into `lists.ts`/`match.ts` rather than imported
 * by them — those stay D1-only by design.
 *
 * **Sends `inbox_update` deliberately, despite nothing arriving in the inbox.** That
 * is the signal already-shipped clients turn into an immediate
 * `WorkScheduler.scheduleSocialSyncNow` (`SocialMessagingService`), and
 * `SocialSyncWorker` now reads the D1 lists and handshakes in the same pass. Inventing
 * a new `type` would be tidier and would reach **no device in the field** until they
 * updated — the whole point of this fix is that it works on the build people already
 * have. Treat it as "wake up and sync", not as a claim about the inbox.
 *
 * Best-effort throughout: a share that was delivered must not fail because a push did.
 */
/**
 * Wake a user's own devices.
 *
 * ⚠️ **Addressing a user has never required a friendship.** `users.friend_id` maps
 * the account to its device folder and the record's `selfTopic` is subscribed to by
 * that user's own devices, so this reaches anyone — friend or stranger's target
 * alike. That is why comment-reaction notifications needed no new addressing
 * mechanism, only a caller.
 *
 * The push record itself still lives in **R2**, which is the last relay dependency
 * on this path. When the relay is retired it has to move to a D1 `device_tokens`
 * table keyed by **token** (not by user+device: a token migrates between users on a
 * shared device, and keying on the device eventually delivers one person's
 * notifications to another). Nothing above this line changes when it does.
 *
 * @param data extra `data` fields for the client to render without a round trip.
 * @param collapseKey replaces an earlier notification about the same subject rather
 *   than stacking beside it — see [sendFcmMessage].
 */
async function notifyAccount(
  env: Env,
  userId: string,
  data: Record<string, string> = {},
  collapseKey?: string,
): Promise<void> {
  try {
    const row = await env.DB.prepare("SELECT friend_id FROM users WHERE id = ?")
      .bind(userId)
      .first<{ friend_id: string | null }>();
    const friendId = row?.friend_id;
    // No claimed friendId means no device has ever published a push record — there is
    // nothing to wake, and that is normal for a brand-new account.
    if (!friendId) return;
    const config = fcmConfig(env);
    if (!config) return;
    const target = pickFcmTarget(await readPushRecord(env, friendId), "self");
    if (!target) return;
    // `kind` distinguishes a rendered notification from the bare "sync now" wake
    // every other caller sends; the client switches on it.
    const type = data.kind ? data.kind : "inbox_update";
    await sendFcmMessage(config, target, friendId, type, data, collapseKey);
  } catch (e) {
    console.error("notifyAccount failed", e);
  }
}

async function resolveCardOwner(env: Env, code: string): Promise<string | null> {
  const card = await getJson<{ serverUserId?: unknown }>(env, `fc/${code}.json`);
  const owner = card && typeof card.serverUserId === "string" ? card.serverUserId : "";
  return owner || null;
}

// ── Portable identity backup ──────────────────────────────────────────────────
// Zero-knowledge: the relay stores ciphertext under a blind-index lookup key the
// owner derives from their recovery code (HKDF). The relay can neither read the
// bundle nor link it to a friendId. Possession of the unguessable lookup key is
// the only authorization needed — only the owner can derive it.

async function handlePutBackup(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (body.length > MAX_BACKUP_BYTES) return tooLarge();
  let parsed: { lookupKey?: unknown; ciphertext?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return invalidJson();
  }
  const lookupKey = typeof parsed.lookupKey === "string" ? parsed.lookupKey : "";
  const ciphertext = typeof parsed.ciphertext === "string" ? parsed.ciphertext : "";
  if (!new RegExp(`^${LOOKUP_KEY}$`).test(lookupKey) || !ciphertext) {
    return json({ error: "invalid_payload" }, { status: 400 });
  }
  await putJson(env, `backup/${lookupKey}.json`, { ciphertext });
  return json({ ok: true });
}

async function handleGetBackup(lookupKey: string, env: Env): Promise<Response> {
  const rec = await getJson<{ ciphertext: string }>(env, `backup/${lookupKey}.json`);
  return rec ? json({ ciphertext: rec.ciphertext }) : notFound();
}

async function handleDeleteBackup(lookupKey: string, env: Env): Promise<Response> {
  await env.BUCKET.delete(`backup/${lookupKey}.json`);
  return json({ ok: true });
}

// ── Live friends+block record ───────────────────────────────────────────────
// Per-user encrypted friend + block list, kept current across the user's own
// devices. The relay stores ciphertext only — it never sees who is friends with
// whom. Optimistic concurrency: the writer presents the version it based its
// edit on; a mismatch returns 409 so the client re-pulls, LWW-merges, retries.

interface SelfRecord {
  ciphertext: string;
  version: number;
}

async function handleGetSelf(lookupKey: string, env: Env): Promise<Response> {
  const rec = await getJson<SelfRecord>(env, `self/${lookupKey}.json`);
  return rec ? json({ ciphertext: rec.ciphertext, version: rec.version }) : notFound();
}

async function handlePutSelf(lookupKey: string, req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (body.length > MAX_SELF_BYTES) return tooLarge();
  let parsed: { ciphertext?: unknown; baseVersion?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return invalidJson();
  }
  const ciphertext = typeof parsed.ciphertext === "string" ? parsed.ciphertext : "";
  const baseVersion = typeof parsed.baseVersion === "number" ? parsed.baseVersion : NaN;
  if (!ciphertext || !Number.isFinite(baseVersion)) {
    return json({ error: "invalid_payload" }, { status: 400 });
  }
  const existing = await getJson<SelfRecord>(env, `self/${lookupKey}.json`);
  const currentVersion = existing?.version ?? 0;
  if (baseVersion !== currentVersion) {
    return json({ error: "version_conflict", version: currentVersion }, { status: 409 });
  }
  const next: SelfRecord = { ciphertext, version: currentVersion + 1 };
  await putJson(env, `self/${lookupKey}.json`, next);
  return json({ ok: true, version: next.version });
}

async function handleDeleteSelf(lookupKey: string, env: Env): Promise<Response> {
  await env.BUCKET.delete(`self/${lookupKey}.json`);
  return json({ ok: true });
}

// ── Account / data deletion ───────────────────────────────────────────────────

// Remove every object stored under a friendId prefix, plus the public friend
// card it points at. Returns the number of relay objects removed.
async function purgeFriendScoped(env: Env, friendId: string): Promise<number> {
  const fc = await getJson<FcOwnerRecord>(env, `${friendId}/friendcode.json`);
  let removed = await deletePrefix(env, `${friendId}/`);
  if (fc?.c) {
    await env.BUCKET.delete(`fc/${fc.c}.json`);
    removed += 1;
  }
  return removed;
}

// Owner-authenticated deletion — used by the in-app "Delete my social data"
// action, which holds the write secret. Purges the friendId-scoped relay data
// and, when the caller supplies the blind-index lookup keys it alone can derive,
// the zero-knowledge identity backup and live friends record too.
async function handleSocialDelete(req: Request, env: Env): Promise<Response> {
  let body: { friendId?: unknown; backupLookupKey?: unknown; selfLookupKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return invalidJson();
  }
  const friendId = typeof body.friendId === "string" ? body.friendId : "";
  if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) return json({ error: "invalid_request" }, { status: 400 });
  // Deletion endpoint: intentionally does NOT surface ownerRecreated — signaling
  // "republish" while the user is deleting their data would resurrect it.
  if (!(await verifyOwner(env, friendId, req.headers.get("X-Feed-Secret"))).ok) return forbidden();

  // Drop the linked-account record (keyed by the reverse pointer under this
  // friendId) before purging the prefix, so the Play data-deletion promise holds.
  await deleteAccountForFriend(env, friendId);
  let removed = await purgeFriendScoped(env, friendId);
  const backupLookupKey = typeof body.backupLookupKey === "string" ? body.backupLookupKey : "";
  const selfLookupKey = typeof body.selfLookupKey === "string" ? body.selfLookupKey : "";
  if (new RegExp(`^${LOOKUP_KEY}$`).test(backupLookupKey)) {
    await env.BUCKET.delete(`backup/${backupLookupKey}.json`);
    removed += 1;
  }
  if (new RegExp(`^${LOOKUP_KEY}$`).test(selfLookupKey)) {
    await env.BUCKET.delete(`self/${selfLookupKey}.json`);
    removed += 1;
  }
  return json({ ok: true, removed });
}

// Web fallback for users who no longer have the app: identify the account by its
// public friend code and purge the friendId-scoped relay data immediately. The
// zero-knowledge backup + friends record are NOT touched here (their blind-index
// keys require the recovery code), so the user's private recovery path stays
// intact and only they — via the in-app reset — can remove it.
async function handleDeleteRequest(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = Number(env.RATE_LIMIT_PER_HOUR ?? "10");
  if (await rateLimited(env, "delreq", ip, limit)) return json({ error: "rate_limited" }, { status: 429 });

  let body: { code?: unknown };
  try {
    body = (await req.json()) as { code?: unknown };
  } catch {
    return invalidJson();
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!new RegExp(`^${FRIEND_CODE}$`).test(code)) return json({ error: "invalid_code" }, { status: 400 });

  const card = await getJson<{ friendId?: unknown }>(env, `fc/${code}.json`);
  const friendId = card && typeof card.friendId === "string" ? card.friendId : "";
  if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) return notFound();

  const removed = await purgeFriendScoped(env, friendId);
  return json({ ok: true, removed });
}

// List + delete every object under a prefix, following the R2 list cursor.
async function deletePrefix(env: Env, prefix: string): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const listed = await env.BUCKET.list({ prefix, cursor });
    if (listed.objects.length) {
      await env.BUCKET.delete(listed.objects.map((o) => o.key));
      removed += listed.objects.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return removed;
}

// ── Share links ──────────────────────────────────────────────────────────────

async function handleCreate(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = Number(env.RATE_LIMIT_PER_HOUR ?? "10");
  if (await rateLimited(env, "share", ip, limit)) return json({ error: "rate_limited" }, { status: 429 });

  let payload: SharePayload;
  try {
    payload = (await req.json()) as SharePayload;
  } catch {
    return invalidJson();
  }
  if (!payload || typeof payload.title !== "string") {
    return json({ error: "invalid_payload" }, { status: 400 });
  }

  const kind = payload.kind === "smart" ? "smart" : "manual";
  const title = payload.title.slice(0, 120);
  const maxItems = Number(env.MAX_ITEMS ?? "100");

  let items: ShareItem[] = [];
  let filters: unknown | null = null;

  if (kind === "smart") {
    if (!payload.filters || typeof payload.filters !== "object") {
      return json({ error: "invalid_filters" }, { status: 400 });
    }
    if (JSON.stringify(payload.filters).length > MAX_FILTERS_BYTES) {
      return json({ error: "filters_too_large" }, { status: 400 });
    }
    filters = payload.filters;
  } else {
    if (!Array.isArray(payload.items) || payload.items.length === 0 || payload.items.length > maxItems) {
      return json({ error: "invalid_payload" }, { status: 400 });
    }
    items = payload.items
      .slice(0, maxItems)
      .map((it) => ({ tmdbId: Number(it.tmdbId) | 0, type: String(it.type).slice(0, 8) }))
      .filter((it) => it.tmdbId > 0);
    if (items.length === 0) return json({ error: "empty_after_validation" }, { status: 400 });
  }

  const ttl = Number(env.SHARE_TTL_SECONDS ?? "2592000");
  const code = await generateUniqueCode(env);
  const now = new Date();
  // Attribution when it happens to be available. This endpoint is and stays
  // unauthenticated, so a missing/invalid session is the normal case and must not
  // change the outcome — hence the resolve is best-effort and never gates.
  const creator = await runOptionalSession(req, env);
  const stored: StoredShare = {
    kind,
    title,
    items,
    filters,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    views: 0,
    creatorId: creator,
  };
  await putJson(env, `share/${code}.json`, stored);
  return json({ code, expiresAt: stored.expiresAt });
}

async function handleGet(code: string, env: Env): Promise<Response> {
  const stored = await getJson<StoredShare>(env, `share/${code}.json`);
  if (!stored || isExpired(stored) || stored.hidden) return notFound();
  return json(normalizeStored(stored));
}

async function handleLanding(code: string, env: Env): Promise<Response> {
  const stored = await getJson<StoredShare>(env, `share/${code}.json`);
  // A hidden link is indistinguishable from an expired one, deliberately and to
  // the byte — same status, same body. See [StoredShare.hidden].
  if (!stored || isExpired(stored) || stored.hidden) return html(landingNotFound(), { status: 404 });
  // Read-only render: does not increment views (that's the app's /api GET).
  return html(landingPage(code, normalizeStored(stored)));
}

function isExpired(s: { expiresAt?: string }): boolean {
  return !!s.expiresAt && new Date(s.expiresAt).getTime() < Date.now();
}

// ── Utilities ────────────────────────────────────────────────────────────────

async function sha256hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Back-fills fields absent on shares stored before the kind/filters split.
function normalizeStored(parsed: any): StoredShare {
  return {
    kind: parsed.kind === "smart" ? "smart" : "manual",
    title: typeof parsed.title === "string" ? parsed.title : "Shared list",
    items: Array.isArray(parsed.items) ? parsed.items : [],
    filters: parsed.filters ?? null,
    createdAt: parsed.createdAt ?? new Date().toISOString(),
    expiresAt: parsed.expiresAt ?? new Date().toISOString(),
    views: Number(parsed.views ?? 0),
  };
}

// Deliberately NOT normalized onto the wire: this builds the *public* shape, and
// `creatorId` would hand the creator's account id to anyone holding the link.
// Both `hidden` and `creatorId` are read straight off the stored object by the
// handlers that need them.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

async function generateUniqueCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(6);
    if (!(await env.BUCKET.head(`share/${code}.json`))) return code;
  }
  return randomCode(8);
}

async function generateUniqueFriendCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(6);
    if (!(await env.BUCKET.head(`fc/${code}.json`))) return code;
  }
  return randomCode(8);
}

function randomCode(length: number): string {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

function landingPage(code: string, stored: StoredShare): string {
  const intentUrl =
    `intent://share/${code}#Intent;scheme=flickto;package=${APP_PACKAGE};` +
    `S.browser_fallback_url=${encodeURIComponent(PLAY_STORE_URL)};end`;
  const subtitle =
    stored.kind === "smart"
      ? "Smart list · rebuilds on your device"
      : `${stored.items.length} title${stored.items.length === 1 ? "" : "s"}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${htmlEscape(stored.title)} · FlickTo</title>
    <style>
      :root { color-scheme: dark; }
      body {
        font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        background: #0e1014; color: #e8eaf0;
        display: flex; min-height: 100vh; margin: 0;
        align-items: center; justify-content: center; padding: 1.5rem;
      }
      .card { max-width: 420px; width: 100%; text-align: center; }
      h1 { font-size: 24px; margin: 0 0 0.25rem; }
      .muted { color: #8a93a6; margin: 0 0 1.75rem; }
      .btn {
        display: block; width: 100%; box-sizing: border-box;
        padding: 0.9rem 1rem; border-radius: 12px; text-decoration: none;
        font-weight: 600; margin-bottom: 0.75rem;
      }
      .primary { background: #ffb547; color: #0e1014; }
      .secondary { background: #1b2030; color: #e8eaf0; }
      .report {
        background: none; border: 0; color: #8a93a6; text-decoration: underline;
        font: inherit; cursor: pointer; margin-top: 1.25rem; padding: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${htmlEscape(stored.title)}</h1>
      <p class="muted">${subtitle}</p>
      <a class="btn primary" id="open" href="${intentUrl}">Open in FlickTo</a>
      <a class="btn secondary" href="${PLAY_STORE_URL}">Get it on Google Play</a>
      <a class="btn secondary" href="${APP_STORE_URL}">Download on the App Store</a>
      <!--
        Whoever is reading this page is the person most likely to have been sent an
        abusive link, and almost never has an account. Requiring one to report would
        leave that audience with no route at all — so this posts anonymously. It
        cannot take the link down on its own; see handleShareReport.
      -->
      <button class="report" id="report">Report this list</button>
    </div>
    <script>
      document.getElementById("report").addEventListener("click", async function () {
        this.disabled = true;
        this.textContent = "Thanks — this has been sent for review";
        try {
          await fetch("/api/share/${code}/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "landing_page" }),
          });
        } catch (e) {
          // The confirmation is deliberately unconditional: a failed POST is not
          // the reporter's problem to solve, and re-enabling the button would only
          // invite a retry loop against a rate limit.
        }
      });
    </script>
    <!--
      No auto-redirect: Chrome blocks gesture-less navigation to an intent://
      URL and falls through to browser_fallback_url (the store). The user taps
      "Open in FlickTo" instead — that gesture is honored and opens the app.
      Links clicked from App-Link-aware apps open the app directly and never
      reach this page.
    -->
  </body>
</html>`;
}

function landingNotFound(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>List not found · FlickTo</title>
    <style>
      :root { color-scheme: dark; }
      body {
        font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        background: #0e1014; color: #e8eaf0;
        display: flex; min-height: 100vh; margin: 0;
        align-items: center; justify-content: center; padding: 1.5rem; text-align: center;
      }
      a { color: #ffb547; }
    </style>
  </head>
  <body>
    <div>
      <h1>This list expired or doesn't exist</h1>
      <p>Shared lists are kept for 30 days. <a href="${PLAY_STORE_URL}">Get FlickTo</a></p>
    </div>
  </body>
</html>`;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Legal / compliance pages (/privacy, /delete) have been moved to static HTML
// files served by the flickto-content worker. The inline templates that were
// here (privacyPage(), deletePage(), LEGAL_CSS) have been extracted to:
//   flickd-content/content/privacy.html
//   flickd-content/content/delete.html




