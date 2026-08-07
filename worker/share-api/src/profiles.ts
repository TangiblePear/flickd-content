// ── Server-authoritative profiles (Phase 2) ──────────────────────────────────
// The profile now lives here, not on the device. The client keeps Room as an
// offline cache, but the server row wins on read.
//
// Concurrency is optimistic on `profiles.version` and nothing else: a PUT sends
// `If-Match: <version>` and gets 409 + the current version if it lost. That single
// mechanism replaces the client's per-field last-write-wins layer.
//
// Request budget, not query budget, is the binding constraint on the free plan
// (§12 of the plan), which is why `/api/me/bootstrap` exists — one request on app
// open instead of three.

import { canView, canViewAnonymous, parseVisibility, Visibility } from "./authz";
import { resolveSession } from "./auth";
import { loadFriendships } from "./friends";
import { loadFeed } from "./feed";
import { postingSuspendedUntil, suspendedBody } from "./suspension";
import { readSettingsRow, toSettingsWire } from "./settings";
import { readAchievementsRow, toAchievementsWire } from "./achievements";

export interface ProfileEnv {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
  /**
   * Lowest Android `versionCode` still allowed on the social surface, as a string
   * (wrangler `vars` are always strings). Unset or unparseable ⇒ 0 ⇒ no gate, which
   * is the correct default: a typo in this var must not lock every user out.
   *
   * Raised only when retiring the E2EE relay profile path, so no build that still
   * READS the relay is left running when the writes stop. Record the value and the
   * date it was raised in the plan doc — an unrecorded flip is unauditable.
   */
  MIN_SOCIAL_VERSION?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, X-Revoke-Session, X-App-Version",
};

/** The configured social floor, or 0 when unset/invalid. Never throws. */
export function minSocialVersion(env: { MIN_SOCIAL_VERSION?: string }): number {
  const n = Number(env.MIN_SOCIAL_VERSION);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The caller's `X-App-Version`, or 0 when absent or junk.
 *
 * 0 means "unknown", and unknown must NOT be treated as below the floor: the PWA and
 * every pre-gate Android build send no header at all, and refusing them would break
 * clients this gate was never aimed at. Enforcement is against builds that identify
 * themselves as too old.
 */
export function appVersion(req: Request): number {
  const n = Number(req.headers.get("X-App-Version"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });

const unauthorized = () => json({ error: "unauthorized" }, 401);
/** Used for BOTH "no such profile" and "not allowed" — see the authz.ts header. */
const notFound = () => json({ error: "not_found" }, 404);

// ── Size caps. Every one of these is a write the client controls. ──
const MAX_BIO = 500;
const MAX_NAME = 60;
const MAX_SHORT = 120; // ids, hex colours
const MAX_URL = 500;
const MAX_LAYOUT_BYTES = 8 * 1024;
const MAX_STATS_BYTES = 16 * 1024;
const MAX_LIST_ITEMS = 50;
const USER_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface ProfileRow {
  user_id: string;
  display_name: string | null;
  avatar_id: string | null;
  border_id: string | null;
  picture_url: string | null;
  header_color: string | null;
  header_backdrop_url: string | null;
  layout: string | null;
  /** The owner's layout with owner-only and unconsented blocks already stripped. */
  friend_layout: string | null;
  /**
   * The owner's layout filtered for NON-FRIENDS — a strict subset of `friend_layout`
   * unless the owner has turned on public activity. NULL = the client predates the field.
   */
  public_layout: string | null;
  bio: string | null;
  favourite_movies: string | null;
  favourite_shows: string | null;
  favourite_people: string | null;
  featured_achievements: string | null;
  personality_id: string | null;
  visibility: string;
  version: number;
  updated_at: number;
}

const PROFILE_COLUMNS =
  "user_id, display_name, avatar_id, border_id, picture_url, header_color, header_backdrop_url, " +
  "layout, friend_layout, public_layout, bio, favourite_movies, favourite_shows, favourite_people, " +
  "featured_achievements, personality_id, visibility, version, updated_at";

/** Parse a JSON column, falling back to [fallback] rather than throwing on a bad row. */
function jsonColumn<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Row → wire. Absent columns become empty values, never null, so clients need no null-handling. */
export function toWire(row: ProfileRow) {
  return {
    userId: row.user_id,
    displayName: row.display_name ?? "",
    avatarId: row.avatar_id ?? "",
    borderId: row.border_id ?? "",
    pictureUrl: row.picture_url ?? "",
    headerColor: row.header_color ?? "",
    headerBackdropUrl: row.header_backdrop_url ?? "",
    layout: jsonColumn<unknown[]>(row.layout, []),
    bio: row.bio ?? "",
    favouriteMovies: jsonColumn<number[]>(row.favourite_movies, []),
    favouriteShows: jsonColumn<number[]>(row.favourite_shows, []),
    favouritePeople: jsonColumn<unknown[]>(row.favourite_people, []),
    featuredAchievements: jsonColumn<unknown[]>(row.featured_achievements, []),
    personalityId: row.personality_id ?? "",
    visibility: parseVisibility(row.visibility),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

/** Which filtered view of a profile a foreign reader receives. */
export type ForeignAudience = "friend" | "public";

/**
 * Row → wire **for someone who is not the owner**.
 *
 * The only difference is `layout`, and it is the whole point: a foreign reader gets the
 * layout matching their [audience] — `friend_layout` for a friend, `public_layout` for a
 * stranger — both already stripped by the client that published them, under the same
 * field name. The unfiltered `layout` is not in the response at all, so no caller can
 * read it by mistake. That is the safety property; a flag saying "don't read this one"
 * would not be.
 *
 * `null` when the owner's client predates the field, which is NOT "they have no blocks".
 * Readers must keep whatever they already had, or every friend of an un-updated client
 * flips to the default layout the first time this is read.
 *
 * **A null `public_layout` must never fall back to `friend_layout`.** That would serve
 * strangers a layout filtered under a consent given for friends, which is the single
 * outcome this split exists to prevent.
 */
export function toForeignWire(row: ProfileRow, audience: ForeignAudience) {
  const raw = audience === "friend" ? row.friend_layout : row.public_layout;
  return {
    ...toWire(row),
    layout: raw == null ? null : jsonColumn<unknown[]>(raw, []),
  };
}

export async function readProfileRow(env: ProfileEnv, userId: string): Promise<ProfileRow | null> {
  return env.DB.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id = ?`)
    .bind(userId)
    .first<ProfileRow>();
}

async function readStats(env: ProfileEnv, userId: string): Promise<unknown | null> {
  const row = await env.DB.prepare("SELECT stats FROM profile_stats WHERE user_id = ?")
    .bind(userId)
    .first<{ stats: string | null }>();
  return row ? jsonColumn<unknown | null>(row.stats, null) : null;
}

/**
 * The stats blob matching a foreign reader's [audience].
 *
 * Serving `stats` to everyone who passes `canView` was safe only while friends were the
 * sole foreign readers. A stranger's client would otherwise receive `topRated`,
 * `currentlyWatching` and `recentWatches` in the JSON even though its layout hides them —
 * putting the privacy boundary in the viewer's renderer rather than on the server.
 */
async function readStatsFor(env: ProfileEnv, userId: string, audience: ForeignAudience): Promise<unknown | null> {
  if (audience === "friend") return readStats(env, userId);
  const row = await env.DB.prepare("SELECT public_stats FROM profile_stats WHERE user_id = ?")
    .bind(userId)
    .first<{ public_stats: string | null }>();
  return row ? jsonColumn<unknown | null>(row.public_stats, null) : null;
}

// ── Incoming payload validation ──────────────────────────────────────────────

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/** Re-serialize a list field, capping length. Returns null for anything unusable. */
function jsonList(value: unknown, max = MAX_LIST_ITEMS): string | null {
  if (!Array.isArray(value)) return null;
  return JSON.stringify(value.slice(0, max));
}

interface ValidatedProfile {
  display_name: string | null;
  avatar_id: string | null;
  border_id: string | null;
  picture_url: string | null;
  header_color: string | null;
  header_backdrop_url: string | null;
  layout: string | null;
  friend_layout: string | null;
  public_layout: string | null;
  bio: string | null;
  favourite_movies: string | null;
  favourite_shows: string | null;
  favourite_people: string | null;
  featured_achievements: string | null;
  personality_id: string | null;
  visibility: Visibility;
}

/**
 * Merge an incoming payload over the existing row.
 *
 * **Omitted key means "leave unchanged"; present-but-empty means "clear".** This
 * is deliberately NOT a full replace: Android versions in the wild will always lag
 * the API, and a client that has never heard of a field must not blank it. The
 * `version` check still serialises concurrent writers, so this stays safe.
 *
 * Returns null on a payload we refuse outright (oversize layout).
 */
function mergeValidated(body: Record<string, unknown>, existing: ProfileRow | null): ValidatedProfile | null {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const layout = has("layout") ? jsonList(body.layout) : (existing?.layout ?? null);
  if (layout != null && layout.length > MAX_LAYOUT_BYTES) return null;
  // Same cap: it is a strict subset of `layout`, but it arrives as its own field and an
  // unchecked one would be a way straight past the limit the line above enforces.
  const friendLayout = has("friendLayout") ? jsonList(body.friendLayout) : (existing?.friend_layout ?? null);
  if (friendLayout != null && friendLayout.length > MAX_LAYOUT_BYTES) return null;
  // Same cap, same reasoning: it arrives as its own field, so an unchecked one would be a
  // way straight past the limit enforced above.
  const publicLayout = has("publicLayout") ? jsonList(body.publicLayout) : (existing?.public_layout ?? null);
  if (publicLayout != null && publicLayout.length > MAX_LAYOUT_BYTES) return null;

  const text = (key: string, column: keyof ProfileRow, max: number) =>
    has(key) ? str(body[key], max) : ((existing?.[column] as string | null) ?? null);
  const list = (key: string, column: keyof ProfileRow) =>
    has(key) ? jsonList(body[key]) : ((existing?.[column] as string | null) ?? null);

  return {
    display_name: text("displayName", "display_name", MAX_NAME),
    avatar_id: text("avatarId", "avatar_id", MAX_SHORT),
    border_id: text("borderId", "border_id", MAX_SHORT),
    picture_url: text("pictureUrl", "picture_url", MAX_URL),
    header_color: text("headerColor", "header_color", MAX_SHORT),
    header_backdrop_url: text("headerBackdropUrl", "header_backdrop_url", MAX_URL),
    layout,
    friend_layout: friendLayout,
    public_layout: publicLayout,
    bio: text("bio", "bio", MAX_BIO),
    favourite_movies: list("favouriteMovies", "favourite_movies"),
    favourite_shows: list("favouriteShows", "favourite_shows"),
    favourite_people: list("favouritePeople", "favourite_people"),
    featured_achievements: list("featuredAchievements", "featured_achievements"),
    personality_id: text("personalityId", "personality_id", MAX_SHORT),
    // Unknown values fall to `friends` — an unrecognised string must never widen access.
    visibility: has("visibility")
      ? parseVisibility(typeof body.visibility === "string" ? body.visibility : undefined)
      : parseVisibility(existing?.visibility),
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/** GET /api/me/profile — the owner's canonical record. 200 with `profile: null` when none exists yet. */
export async function handleGetMyProfile(req: Request, env: ProfileEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return unauthorized();
  const row = await readProfileRow(env, session.userId);
  if (!row) return json({ profile: null, stats: null });
  return json({ profile: toWire(row), stats: await readStats(env, session.userId) }, 200, {
    ETag: `"${row.version}"`,
  });
}

/**
 * PUT /api/me/profile — replace the owner's profile.
 *
 * `If-Match: <version>` is REQUIRED once a profile exists; a mismatch returns 409
 * with the current version so the client can re-read and retry. `If-Match: 0` (or
 * absent) means "I believe none exists" and only succeeds on a first write.
 */
export async function handlePutMyProfile(req: Request, env: ProfileEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const ifMatchRaw = (req.headers.get("If-Match") ?? "").replace(/"/g, "").trim();
  const ifMatch = ifMatchRaw === "" ? null : Number(ifMatchRaw);
  if (ifMatch != null && !Number.isInteger(ifMatch)) return json({ error: "invalid_if_match" }, 400);

  // Read the whole row, not just the version: fields the client omitted are carried
  // forward rather than blanked (see mergeValidated).
  const existing = await readProfileRow(env, session.userId);
  const next = mergeValidated(body, existing);
  if (!next) return json({ error: "too_large" }, 413);
  const currentVersion = existing?.version ?? 0;
  // Absent If-Match is only acceptable on a first write; otherwise a client with no
  // idea of the current state could silently clobber another device's edit.
  const claimed = ifMatch ?? 0;
  if (claimed !== currentVersion) {
    return json({ error: "version_conflict", version: currentVersion }, 409);
  }

  // ── Posting suspension: profile TEXT only ──────────────────────────────────
  // Compares values rather than checking for the keys. Android sends all 14 fields
  // on every save, so a presence check would block avatar, border, layout and
  // favourite edits too — none of them abuse surfaces — and turn a posting ban into
  // an editing lockout. Costs no extra query: `existing` is already in hand.
  const changesText =
    (next.bio ?? "") !== (existing?.bio ?? "") ||
    (next.display_name ?? "") !== (existing?.display_name ?? "");
  if (changesText) {
    const until = await postingSuspendedUntil(env.DB, session.userId);
    if (until > 0) return json(suspendedBody(until), 403);
  }

  const now = Date.now();
  const version = currentVersion + 1;
  await env.DB.prepare(
    `INSERT INTO profiles (user_id, display_name, avatar_id, border_id, picture_url, header_color,
       header_backdrop_url, layout, friend_layout, public_layout, bio, favourite_movies, favourite_shows,
       favourite_people, featured_achievements, personality_id, visibility, version, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       display_name = excluded.display_name, avatar_id = excluded.avatar_id,
       border_id = excluded.border_id, picture_url = excluded.picture_url,
       header_color = excluded.header_color, header_backdrop_url = excluded.header_backdrop_url,
       layout = excluded.layout, friend_layout = excluded.friend_layout,
       public_layout = excluded.public_layout, bio = excluded.bio,
       favourite_movies = excluded.favourite_movies, favourite_shows = excluded.favourite_shows,
       favourite_people = excluded.favourite_people,
       featured_achievements = excluded.featured_achievements,
       personality_id = excluded.personality_id, visibility = excluded.visibility,
       version = excluded.version, updated_at = excluded.updated_at`,
  )
    .bind(
      session.userId,
      next.display_name,
      next.avatar_id,
      next.border_id,
      next.picture_url,
      next.header_color,
      next.header_backdrop_url,
      next.layout,
      next.friend_layout,
      next.public_layout,
      next.bio,
      next.favourite_movies,
      next.favourite_shows,
      next.favourite_people,
      next.featured_achievements,
      next.personality_id,
      next.visibility,
      version,
      now,
    )
    .run();

  return json({ version, updatedAt: now }, 200, { ETag: `"${version}"` });
}

/**
 * PUT /api/me/stats — derived data, versionless. Rewritten wholesale by the owner.
 *
 * Takes `{ stats, publicStats }`. Both blobs travel in ONE request so the friend and
 * public views cannot diverge; two endpoints would let one land without the other.
 *
 * **A bare snapshot is a pre-public-profiles client.** Those builds are in the wild and
 * keep sending the unwrapped object, so it is stored as the friend stats and
 * `public_stats` is left untouched — they have no public layout to match it to.
 */
export async function handlePutMyStats(req: Request, env: ProfileEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const has = (key: string) =>
    body != null && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, key);
  const isEnvelope = has("stats") || has("publicStats");
  const envelope = body as Record<string, unknown> | null;

  const serialized = JSON.stringify((isEnvelope ? envelope!.stats : body) ?? null);
  if (serialized.length > MAX_STATS_BYTES) return json({ error: "too_large" }, 413);

  // `undefined` = leave the column alone (legacy client). `null` = clear it, which is what
  // a profile leaving public sends.
  const publicSerialized = !isEnvelope
    ? undefined
    : envelope!.publicStats == null
      ? null
      : JSON.stringify(envelope!.publicStats);
  if (publicSerialized != null && publicSerialized.length > MAX_STATS_BYTES) {
    return json({ error: "too_large" }, 413);
  }

  if (isEnvelope) {
    const at = Date.now();
    await env.DB.prepare(
      `INSERT INTO profile_stats (user_id, stats, public_stats, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET stats = excluded.stats,
         public_stats = excluded.public_stats, updated_at = excluded.updated_at`,
    )
      .bind(session.userId, serialized, publicSerialized, at)
      .run();
    return json({ updatedAt: at });
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO profile_stats (user_id, stats, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET stats = excluded.stats, updated_at = excluded.updated_at`,
  )
    .bind(session.userId, serialized, now)
    .run();
  return json({ updatedAt: now });
}

/**
 * GET /api/profile/{userId} — a foreign profile, gated by [canView].
 *
 * Denied and nonexistent both return **404 `not_found`**, byte-identical, so this
 * cannot be used to enumerate accounts or detect a block.
 *
 * **Readable without a session** when the profile is public: this is what
 * `flickto.app/u/{userId}` serves to someone who does not have an account, which is the
 * whole point of a shareable link. A signed-out reader is judged by
 * [canViewAnonymous] and can only ever reach the `public` audience — a friends-only or
 * private profile answers 404, identically to one that does not exist, so signing out
 * reveals strictly less than signing in, never more.
 */
export async function handleGetProfile(
  userId: string,
  req: Request,
  env: ProfileEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!USER_ID_RE.test(userId)) return notFound();

  const row = await readProfileRow(env, userId);
  if (!row) return notFound();
  const visibility = parseVisibility(row.visibility);
  const grant = session
    ? await canView(env, session.userId, userId, visibility)
    : canViewAnonymous(visibility);
  if (grant === null) return notFound();

  // "owner" only reaches here if the owner uses the foreign route (they normally read
  // /api/me/profile). Mapping it explicitly keeps it out of the `public` branch, which
  // would otherwise show them the stranger view of themselves.
  const audience: ForeignAudience = grant === "public" ? "public" : "friend";
  // toForeignWire, NOT toWire: the latter carries the owner's unfiltered layout.
  return json({ profile: toForeignWire(row, audience), stats: await readStatsFor(env, userId, audience) });
}

/**
 * GET /api/me/bootstrap — everything app-open needs, in ONE request.
 *
 * Not an optimisation for later: the Worker request cap is ~17× tighter than the
 * D1 row budget on the free plan, so collapsing three calls into one roughly
 * triples the supported user count.
 *
 * Since Phase 3 this also carries the friend graph, so app-open is genuinely one
 * request: profile, stats, accepted friends and pending requests in both
 * directions.
 */
export async function handleBootstrap(req: Request, env: ProfileEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return unauthorized();
  const row = await readProfileRow(env, session.userId);
  const friendships = await loadFriendships(env as any, session.userId);
  // Preferences and achievements ride app-open for the same reason minSocialVersion and
  // the feed page do: this request is already paid for, and Worker requests bind far
  // tighter than rows. It is also what makes a restore on a new device cost ZERO extra
  // requests — the sign-in pull is this call and nothing more.
  //
  // Null means "this account has none stored", which for an existing user is the normal
  // case and must be read as "push yours", never as "you have none, adopt the blank".
  const settingsRow = await readSettingsRow(env, session.userId);
  const achievementsRow = await readAchievementsRow(env, session.userId);
  return json({
    userId: session.userId,
    profile: row ? toWire(row) : null,
    stats: row ? await readStats(env, session.userId) : null,
    settings: settingsRow ? toSettingsWire(settingsRow) : null,
    achievements: achievementsRow ? toAchievementsWire(achievementsRow) : null,
    friends: friendships.accepted,
    pending: friendships.incoming,
    outgoing: friendships.outgoing,
    // First page of the feed rides along: app-open should cost ONE request, and
    // the Worker request cap binds far tighter than the row budget.
    feed: await loadFeed(env as any, session.userId, 50),
    // The social minimum version rides app-open rather than its own endpoint or
    // Remote Config: this request is already paid for, and Worker requests are the
    // binding constraint. Additive — older clients ignore the field.
    minSocialVersion: minSocialVersion(env),
    // Rides app-open for the same reason minSocialVersion does: this request is already
    // paid for, and Worker requests are the binding constraint. It lets the composer
    // refuse up front instead of letting someone type a comment that will 403 on the
    // next outbox sweep, minutes later and out of sight.
    postingSuspendedUntil: await postingSuspendedUntil(env.DB, session.userId),
    serverTime: Date.now(),
  });
}
