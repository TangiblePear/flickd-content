/**
 * The watch-history document: packing, merging and gzip.
 *
 * ## Why a document rather than rows
 *
 * This app imports whole back-catalogues at signup (Trakt, SIMKL, TV Time, Netflix), so
 * a user arrives with 10–30k events rather than accumulating a few hundred a year. As
 * per-event D1 rows that is **362 bytes per event, measured** — 725 GB at 100k users
 * against a 10 GB database ceiling that Cloudflare states cannot be raised. The same
 * events packed per-title and gzipped are **6.1 bytes each**: 12 GB, no ceiling.
 *
 * Two things produce that 59×, and both are about repetition rather than compression:
 *
 *  - a row restates `user_id` and a derivable event id on EVERY event (~122 GB of pure
 *    key repetition at 2 billion rows). Here the user id is the object's *name*, and
 *    the event id is rebuilt from title + season + episode + second, so neither is stored;
 *  - episodes of one show share a single entry instead of carrying their own row header,
 *    index entries and page slack.
 *
 * ## Per-title packing is what makes MERGE trivial
 *
 * Size is the lesser reason. Two devices that both watched things offline converge by
 * **unioning episode sets**, which is commutative and associative — so merge order does
 * not matter, no device can clobber another, and there is no conflict to resolve. That
 * property is why the shape is per-title rather than a flat event array.
 *
 * Everything in this file is PURE (no R2, no D1, no env) so the merge rules can be
 * tested directly. A merge bug here is silent — it looks like "that device is a bit
 * behind" — so it must be provable in isolation.
 */

/**
 * How long a tombstone is retained.
 *
 * ## Why this is 90 days and not the 30 the plan suggested
 *
 * A tombstone exists so a deletion REACHES the account's other devices: a row that merely
 * vanished is indistinguishable from one that never synced, so an offline device would
 * re-upload it. Purge one too early and that is exactly what happens — the deleted watch
 * comes back, on every device, silently.
 *
 * The saving is negligible against that risk. A tombstone is ~15 bytes gzipped, so a user
 * deleting 100 items a year adds ~1.5 KB/year to a ~180 KB document. There is no storage
 * case for being aggressive here, and a device offline for three months is far rarer than
 * one offline for one.
 */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Hard ceiling, so the map cannot grow without bound however the TTL behaves.
 *
 * Age alone is not a bound: a user who deletes thousands of rows in a week has thousands of
 * young tombstones. Oldest are dropped first, since they are the ones every device has had
 * the most opportunity to see.
 */
export const MAX_TOMBSTONES = 5000;

/** Bump only for a shape change readers must branch on. */
export const DOC_VERSION = 1;

/** One watch: [epochSECONDS, progressPct, source]. Seconds, not millis — see packWatch. */
export type PackedWatch = [number, number, string];

export interface PackedTitle {
  /** SHOW only: `"2x5"` → the watches of that episode. */
  eps?: Record<string, PackedWatch[]>;
  /** MOVIE only: watches of the film itself. */
  w?: PackedWatch[];
  /**
   * TheTVDB id for a show. Stored ONCE per title rather than on every event — it is a
   * property of the show, not of a viewing. Carried because a device restoring from the
   * server would otherwise lose it, and the episode-notification path resolves shows by
   * tvdbId (`getDistinctWatchedShowTmdbAndTvdb`); re-deriving it costs an API round trip
   * per show.
   */
  tv?: number;
  /** Explicit user action only — never written by a watch. */
  rating?: number;
  status?: string;
  feedback?: string;
  /** When the rating/status last changed. Drives last-write-wins on merge. */
  rAt?: number;
  /**
   * Document version at which this title last changed. Drives the delta pull.
   *
   * ⚠️ **Absent means "unknown", never "unchanged".** Every title written before this
   * field existed lacks it, and a delta that filtered those out would hand a behind
   * client an empty document which it would accept as current — silent data loss on the
   * exact accounts that already had history. Readers MUST fail open on `undefined`.
   */
  mv?: number;
}

export interface HistoryDoc {
  v: number;
  /** `"SHOW|1396"` / `"MOVIE|550"`. */
  titles: Record<string, PackedTitle>;
  /**
   * Tombstones: canonical event id → when it was deleted.
   *
   * Kept in the document rather than dropped silently, because a delete has to REACH the
   * account's other devices. A row that had merely vanished is indistinguishable from one
   * that never synced, so the offline device would resurrect it on its next push.
   */
  deleted: Record<string, number>;
  updatedAt: number;
  /**
   * The document's own version, incremented by each successful merge.
   *
   * ⚠️ Lives HERE rather than being derived from `history_meta`, and that is what makes
   * the delta correct under concurrency. The R2 CAS serialises writers, so a version
   * computed from the document that was actually stored cannot be handed to two
   * different states. Deriving it from a `readMeta` taken before the merge could: two
   * devices both read 19, both write, and both label their result 20 — after which a
   * client sitting at 20 never receives one of them, permanently and silently.
   */
  ver?: number;
}

export const emptyDoc = (): HistoryDoc => ({ v: DOC_VERSION, titles: {}, deleted: {}, updatedAt: 0 });

export const titleKey = (mediaType: string, tmdbId: number): string => `${mediaType}|${tmdbId}`;

/** `"2x5"`. Season and episode are already validated integers by the time they arrive. */
export const epKey = (season: number, episode: number): string => `${season}x${episode}`;

/**
 * An event as the sync endpoint has already validated it. Deliberately structural rather
 * than importing the endpoint's type: this module must stay free of HTTP concerns.
 */
export interface IncomingEvent {
  id: string;
  mediaType: string;
  tmdbId: number;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  watchedAt: number;
  source?: string;
  progressPct?: number;
  tvdbId?: number | null;
  deletedAt?: number | null;
}

export interface IncomingRating {
  mediaType: string;
  tmdbId: number;
  rating?: number | null;
  watchStatus?: string | null;
  feedback?: string | null;
  updatedAt: number;
}

/**
 * Watch timestamps are stored in SECONDS.
 *
 * The client's canonical event id already floors `watchedAt` to a second
 * (`HistoryRepository.buildWatchedItemId` divides by 1000), so millisecond precision is
 * not merely wasted space — two devices reporting the same watch with different millis
 * would produce the same id but different packed entries, and dedupe would fail on
 * exactly the case dedupe exists for. Seconds keep the packed form and the id agreeing.
 */
const toSeconds = (ms: number): number => Math.floor(ms / 1000);

/** Same rule the client uses; `EPISODE` and `tv` both mean SHOW. */
export const normaliseType = (t: string): string => (t.trim().toUpperCase() === "MOVIE" ? "MOVIE" : "SHOW");

/**
 * Fold events and ratings into a document, in place, returning it.
 *
 * Idempotent by construction: applying the same event twice is a no-op, because a watch
 * is identified by its second and duplicates are dropped. That is what lets a client
 * re-send a batch it is unsure landed — which the outbox does whenever a response is
 * lost after the write succeeded.
 */
export function applyToDoc(
  doc: HistoryDoc,
  events: IncomingEvent[],
  ratings: IncomingRating[],
  now: number,
): HistoryDoc {
  // Derived from the document itself, not from a caller-supplied number: see `ver`. Each
  // title this pass modifies is stamped with it, so a later reader can answer "what
  // changed since version N" without the document ever having been a log.
  const version = (doc.ver ?? 0) + 1;

  for (const e of events) {
    const mt = normaliseType(e.mediaType);
    const key = titleKey(mt, e.tmdbId);

    // A tombstone removes the watch AND records the deletion, so other devices learn it.
    //
    // ⚠️ Its identity comes from the ID, never from the payload. The row is already gone on
    // the client, so it has no title or watch second left to send and fills those fields
    // with placeholders (`tmdbId = 1`, `watchedAt` = the deletion time). Trusting them
    // looked up `titles["MOVIE|1"]`, found nothing, and removed nothing — leaving the
    // document holding a tombstone AND the watch it was meant to delete. Found on live
    // data 2026-08-03: `event_count` rose on a deletion instead of falling.
    if (e.deletedAt != null) {
      doc.deleted[e.id] = e.deletedAt;
      const real = parseEventId(e.id) ?? e;
      removeWatch(doc, titleKey(normaliseType(real.mediaType), real.tmdbId), real);
      continue;
    }

    // ⚠️ A previously-deleted id that comes back is a RE-WATCH, not a resurrection bug.
    // The id is derived from the watch second, so an identical id means the same watch —
    // but a client that deleted and then re-marked it genuinely wants it back. Clearing
    // the tombstone is what makes that possible; leaving it would make the row
    // permanently un-re-addable, and the user would see their re-watch silently ignored.
    if (doc.deleted[e.id] != null) delete doc.deleted[e.id];

    const title = (doc.titles[key] ??= {});
    title.mv = version;
    if (e.tvdbId != null && e.tvdbId > 0) title.tv = e.tvdbId;
    const watch: PackedWatch =  [toSeconds(e.watchedAt), e.progressPct ?? 100, e.source ?? "INTERNAL"];

    if (mt === "SHOW" && e.seasonNumber != null && e.episodeNumber != null) {
      const eps = (title.eps ??= {});
      pushWatch((eps[epKey(e.seasonNumber, e.episodeNumber)] ??= []), watch);
    } else {
      pushWatch((title.w ??= []), watch);
    }
  }

  for (const r of ratings) {
    const mt = normaliseType(r.mediaType);
    const title = (doc.titles[titleKey(mt, r.tmdbId)] ??= {});
    // Last-write-wins on the rating's OWN timestamp, not the document's. A rating edited
    // offline last week must not beat one made on another device yesterday just because
    // it synced later.
    if ((title.rAt ?? 0) > r.updatedAt) continue;
    // Stamped only PAST the last-write-wins guard: a rating that lost is not a change,
    // and stamping it would put the title in every delta while its content stayed the
    // same.
    title.mv = version;
    if (r.rating != null) title.rating = r.rating;
    if (r.watchStatus != null) title.status = r.watchStatus;
    if (r.feedback != null) title.feedback = r.feedback;
    title.rAt = r.updatedAt;
  }

  // Self-heal: a tombstone whose watch is still present is, by construction, corruption.
  //
  // A re-watch clears its own tombstone above, so "tombstoned AND present" cannot arise
  // legitimately in either arrival order. Documents damaged before the fix above will never
  // see that tombstone again — it left the client's outbox long ago — so without this pass
  // they stay wrong forever, and the Phase 4 tombstone sweep would then RESURRECT the
  // deleted watch on every device. Bounded by the tombstone count, which is small.
  for (const id of Object.keys(doc.deleted)) {
    const real = parseEventId(id);
    if (real) removeWatch(doc, titleKey(normaliseType(real.mediaType), real.tmdbId), real);
  }

  // Purge expired tombstones — deliberately AFTER the repair sweep above.
  //
  // ⚠️ The order is load-bearing. The sweep removes any watch that a tombstone says should
  // be gone; only then is the tombstone itself safe to drop. Purging first would delete the
  // record of the deletion while the watch was still in the document, leaving it
  // permanently resurrected with nothing left to say it had ever been deleted.
  //
  // Runs only inside applyToDoc, so it costs nothing on an idle sync — those never touch
  // the document at all.
  const tombstoned = Object.keys(doc.deleted);
  if (tombstoned.length > 0) {
    const cutoff = now - TOMBSTONE_TTL_MS;
    for (const id of tombstoned) {
      if (doc.deleted[id] < cutoff) delete doc.deleted[id];
    }
    const left = Object.keys(doc.deleted);
    if (left.length > MAX_TOMBSTONES) {
      left.sort((a, b) => doc.deleted[a] - doc.deleted[b]); // oldest first
      for (const id of left.slice(0, left.length - MAX_TOMBSTONES)) delete doc.deleted[id];
    }
  }

  doc.updatedAt = now;
  doc.ver = version;
  return doc;
}

/**
 * Add a watch unless that exact second is already recorded.
 *
 * Progress takes the MAX rather than the newer value: progress only ever moves forward in
 * the user's experience of it, so a stale 40% arriving after a 100% would otherwise mark a
 * finished film unfinished — which reads as data loss even though nothing was lost.
 */
function pushWatch(list: PackedWatch[], watch: PackedWatch): void {
  const existing = list.find((w) => w[0] === watch[0]);
  if (!existing) {
    list.push(watch);
    return;
  }
  existing[1] = Math.max(existing[1], watch[1]);
  // A watch that arrives from Trakt after being recorded locally names its real origin;
  // keeping the richer source makes the history page honest about where it came from.
  if (existing[2] === "INTERNAL" && watch[2] !== "INTERNAL") existing[2] = watch[2];
}

/** Drop one watch, pruning empty episodes and empty titles so the document cannot bloat. */
function removeWatch(doc: HistoryDoc, key: string, e: IncomingEvent): void {
  const title = doc.titles[key];
  if (!title) return;
  const second = toSeconds(e.watchedAt);

  if (e.seasonNumber != null && e.episodeNumber != null && title.eps) {
    const ek = epKey(e.seasonNumber, e.episodeNumber);
    const list = title.eps[ek];
    if (list) {
      const kept = list.filter((w) => w[0] !== second);
      if (kept.length) title.eps[ek] = kept;
      else delete title.eps[ek];
    }
    if (Object.keys(title.eps).length === 0) delete title.eps;
  } else if (title.w) {
    const kept = title.w.filter((w) => w[0] !== second);
    if (kept.length) title.w = kept;
    else delete title.w;
  }

  // A title with no watches left but a surviving rating is NOT empty — the user still
  // rated it. Only drop the entry when nothing at all remains.
  if (!title.eps && !title.w && title.rating == null && title.status == null && title.feedback == null) {
    delete doc.titles[key];
  }
}

export interface DocStats {
  eventCount: number;
  titleCount: number;
  lastWatchedAt: number;
  /** Per-title event counts, for the batched Analytics Engine write. */
  perTitle: Array<{ mediaType: string; tmdbId: number; source: string; count: number }>;
}

/**
 * Derive the counters cached on `history_meta` in ONE pass over the document.
 *
 * These exist so the fleet-wide total ("1,043,221 episodes watched") is a `SUM()` over
 * one small row per user rather than a scan of everybody's history — and so a client can
 * be told what it holds without downloading anything.
 */
export function statsFor(doc: HistoryDoc): DocStats {
  let eventCount = 0;
  let lastWatchedAt = 0;
  const perTitle: DocStats["perTitle"] = [];

  for (const [key, title] of Object.entries(doc.titles)) {
    const [mediaType, rawId] = key.split("|");
    const tmdbId = Number(rawId);
    let n = 0;
    let source = "INTERNAL";

    const account = (list: PackedWatch[]) => {
      for (const w of list) {
        n++;
        if (w[0] > lastWatchedAt) lastWatchedAt = w[0];
        if (w[2] && w[2] !== "INTERNAL") source = w[2];
      }
    };
    if (title.eps) for (const list of Object.values(title.eps)) account(list);
    if (title.w) account(title.w);

    eventCount += n;
    if (n > 0 && Number.isFinite(tmdbId)) perTitle.push({ mediaType, tmdbId, source, count: n });
  }

  return {
    eventCount,
    titleCount: Object.keys(doc.titles).length,
    // Back to millis at the boundary: everything outside this module speaks millis.
    lastWatchedAt: lastWatchedAt * 1000,
    perTitle,
  };
}

/**
 * Flatten to the newest N watches, newest first — the shape the client and the public
 * profile both want.
 *
 * The document is keyed by title, so "what did I watch this week" is not directly
 * answerable from it without a pass like this. Precomputing the slice is what keeps the
 * public profile from having to download a 180 KB private history to render ten rows.
 */
export function recentEvents(doc: HistoryDoc, limit: number): Array<{
  mediaType: string;
  tmdbId: number;
  season: number | null;
  episode: number | null;
  watchedAt: number;
  source: string;
}> {
  const out: ReturnType<typeof recentEvents> = [];
  for (const [key, title] of Object.entries(doc.titles)) {
    const [mediaType, rawId] = key.split("|");
    const tmdbId = Number(rawId);
    if (!Number.isFinite(tmdbId)) continue;

    if (title.eps) {
      for (const [ek, list] of Object.entries(title.eps)) {
        const [s, ep] = ek.split("x").map(Number);
        for (const w of list) {
          out.push({ mediaType, tmdbId, season: s, episode: ep, watchedAt: w[0] * 1000, source: w[2] });
        }
      }
    }
    if (title.w) {
      for (const w of title.w) {
        out.push({ mediaType, tmdbId, season: null, episode: null, watchedAt: w[0] * 1000, source: w[2] });
      }
    }
  }
  out.sort((a, b) => b.watchedAt - a.watchedAt);
  return out.slice(0, limit);
}

// ── Serialisation ───────────────────────────────────────────────────────────
//
// gzip is worth ~5.6x on this shape (measured: 99.5 KB -> 17.8 KB for 2,917 events),
// which is most of the difference between "fits" and "does not". CompressionStream is
// available in Workers; the helpers below are async only because of that.

export async function serialiseDoc(doc: HistoryDoc): Promise<ArrayBuffer> {
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  // `pipeThrough` rather than a manual writer: writing by hand means holding two promises
  // (`write` and `close`) that reject when the stream errors, and discarding them with
  // `void` turns a decode failure into an UNHANDLED REJECTION that no local try/catch can
  // see. Piping keeps the whole thing on the awaited path.
  return new Response(new Response(bytes).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

/**
 * Read a stored document back.
 *
 * Returns an EMPTY document rather than throwing on anything unreadable — a corrupt or
 * truncated object must not wedge a user's sync forever. The next push then rebuilds from
 * the client's own Room database, which is the source of truth anyway.
 */
export async function parseDoc(body: ArrayBuffer): Promise<HistoryDoc> {
  try {
    // See serialiseDoc: piping keeps a decode failure on the awaited path so the catch
    // below actually catches it. A manual writer leaks an unhandled rejection instead —
    // and the "corrupt object" case is exactly the one this function exists to survive.
    const stream = new Response(body).body!.pipeThrough(new DecompressionStream("gzip"));
    const text = await new Response(stream).text();
    const parsed = JSON.parse(text) as HistoryDoc;
    if (!parsed || typeof parsed !== "object" || typeof parsed.titles !== "object") return emptyDoc();
    // ⚠️ `ver` must be carried through. This rebuilds the document field by field, so a
    // new top-level field is dropped unless named here — and dropping `ver` would reset
    // the version to 0 on every load, restamping every title on the next write and making
    // every delta a full document forever.
    return {
      v: parsed.v ?? DOC_VERSION,
      titles: parsed.titles ?? {},
      deleted: parsed.deleted ?? {},
      updatedAt: parsed.updatedAt ?? 0,
      ver: parsed.ver ?? 0,
    };
  } catch {
    return emptyDoc();
  }
}

/**
 * Recover a watch's real identity from its canonical client id.
 *
 * `watch-EPISODE-1396-s2e5-1753027200` / `watch-MOVIE-550-1753027200`, produced by
 * `HistoryRepository.buildWatchedItemId`. Parsing rather than storing the id is a large
 * part of why the document is 59x smaller than the rows it replaced — at 2 billion events
 * these strings alone were ~70 GB.
 *
 * It lives here rather than in `history.ts` because the MERGE depends on it: a tombstone
 * carries placeholders for everything except the id, so this is the only way to know which
 * watch it refers to.
 */
export function parseEventId(id: string): IncomingEvent | null {
  const ep = id.match(/^watch-EPISODE-(\d+)-s(\d+)e(\d+)-(\d+)$/);
  if (ep) {
    return {
      id,
      mediaType: "SHOW",
      tmdbId: Number(ep[1]),
      seasonNumber: Number(ep[2]),
      episodeNumber: Number(ep[3]),
      watchedAt: Number(ep[4]) * 1000,
    };
  }
  const mv = id.match(/^watch-(MOVIE|SHOW)-(\d+)-(\d+)$/);
  if (mv) {
    return { id, mediaType: mv[1], tmdbId: Number(mv[2]), watchedAt: Number(mv[3]) * 1000 };
  }
  return null;
}
