// The watch-history document: packing and merge rules.
//
// Every property here fails SILENTLY in production. A merge that loses a device's events
// looks like "that phone is a bit behind". A tombstone that does not stick looks like a
// sync that has not run yet. A rating clobbered by a stale one looks like the user
// misremembering. None of it throws, so assertions are the only thing that can catch it.
//
// This module is pure on purpose — no R2, no D1 — so these run against the real rules
// rather than a fake of them.

import { describe, it, expect } from "vitest";
import {
  applyToDoc,
  emptyDoc,
  parseDoc,
  recentEvents,
  serialiseDoc,
  statsFor,
  type IncomingEvent,
} from "./historyDoc";

const SEC = 1_700_000_000;
const ms = (s: number) => s * 1000;

const ep = (tmdbId: number, s: number, e: number, second: number, over: Partial<IncomingEvent> = {}): IncomingEvent => ({
  id: `watch-EPISODE-${tmdbId}-s${s}e${e}-${second}`,
  mediaType: "SHOW",
  tmdbId,
  seasonNumber: s,
  episodeNumber: e,
  watchedAt: ms(second),
  source: "INTERNAL",
  progressPct: 100,
  ...over,
});

const movie = (tmdbId: number, second: number, over: Partial<IncomingEvent> = {}): IncomingEvent => ({
  id: `watch-MOVIE-${tmdbId}-${second}`,
  mediaType: "MOVIE",
  tmdbId,
  watchedAt: ms(second),
  source: "INTERNAL",
  progressPct: 100,
  ...over,
});

describe("document packing", () => {
  it("collapses many episodes of one show into a single title entry", () => {
    // The whole reason this shape exists: 18.2 events per title measured on real data.
    const doc = emptyDoc();
    applyToDoc(doc, [ep(1396, 1, 1, SEC), ep(1396, 1, 2, SEC + 60), ep(1396, 2, 5, SEC + 120)], [], 1);
    expect(Object.keys(doc.titles)).toEqual(["SHOW|1396"]);
    expect(Object.keys(doc.titles["SHOW|1396"].eps!).sort()).toEqual(["1x1", "1x2", "2x5"]);
    expect(statsFor(doc)).toMatchObject({ eventCount: 3, titleCount: 1 });
  });

  it("keeps movies and shows apart even on the same tmdb id", () => {
    const doc = emptyDoc();
    applyToDoc(doc, [movie(550, SEC), ep(550, 1, 1, SEC)], [], 1);
    expect(Object.keys(doc.titles).sort()).toEqual(["MOVIE|550", "SHOW|550"]);
  });

  it("records a rewatch of the same episode as a second watch", () => {
    const doc = emptyDoc();
    applyToDoc(doc, [ep(1396, 1, 1, SEC), ep(1396, 1, 1, SEC + 86_400)], [], 1);
    expect(doc.titles["SHOW|1396"].eps!["1x1"]).toHaveLength(2);
    expect(statsFor(doc).eventCount).toBe(2);
  });

  it("is idempotent — re-sending the same batch changes nothing", () => {
    // The outbox re-sends whenever a response is lost after the write landed. If that
    // duplicated events, every dropped connection would inflate the user's history.
    const doc = emptyDoc();
    const batch = [ep(1396, 1, 1, SEC), movie(550, SEC)];
    applyToDoc(doc, batch, [], 1);
    applyToDoc(doc, batch, [], 2);
    applyToDoc(doc, batch, [], 3);
    expect(statsFor(doc).eventCount).toBe(2);
  });
});

describe("merge convergence", () => {
  it("unions two devices' offline episodes regardless of merge order", () => {
    // Commutativity is the property that makes this design safe: neither device can
    // clobber the other, and no conflict resolution is needed.
    const a = [ep(1396, 1, 1, SEC), ep(1396, 1, 2, SEC + 60)];
    const b = [ep(1396, 1, 3, SEC + 120), ep(1396, 2, 1, SEC + 180)];

    const ab = applyToDoc(applyToDoc(emptyDoc(), a, [], 1), b, [], 2);
    const ba = applyToDoc(applyToDoc(emptyDoc(), b, [], 1), a, [], 2);

    const keys = (d: typeof ab) => Object.keys(d.titles["SHOW|1396"].eps!).sort();
    expect(keys(ab)).toEqual(["1x1", "1x2", "1x3", "2x1"]);
    expect(keys(ab)).toEqual(keys(ba));
    expect(statsFor(ab).eventCount).toBe(statsFor(ba).eventCount);
  });

  it("does not duplicate an episode both devices recorded", () => {
    const shared = ep(1396, 1, 1, SEC);
    const doc = applyToDoc(applyToDoc(emptyDoc(), [shared], [], 1), [shared], [], 2);
    expect(doc.titles["SHOW|1396"].eps!["1x1"]).toHaveLength(1);
  });

  it("never moves progress backwards", () => {
    // A device that recorded 40% and only got online after another recorded 100% would
    // otherwise mark a finished film unfinished.
    const doc = emptyDoc();
    applyToDoc(doc, [movie(550, SEC, { progressPct: 100 })], [], 1);
    applyToDoc(doc, [movie(550, SEC, { progressPct: 40 })], [], 2);
    expect(doc.titles["MOVIE|550"].w![0][1]).toBe(100);
  });

  it("upgrades an INTERNAL source when the same watch arrives from Trakt", () => {
    const doc = emptyDoc();
    applyToDoc(doc, [movie(550, SEC, { source: "INTERNAL" })], [], 1);
    applyToDoc(doc, [movie(550, SEC, { source: "TRAKT" })], [], 2);
    expect(doc.titles["MOVIE|550"].w![0][2]).toBe("TRAKT");
  });

  it("ignores millisecond jitter on the same watch", () => {
    // The client's event id floors to the second, so two devices reporting the same watch
    // with different millis share an id. If the packed form disagreed, dedupe would fail
    // on precisely the case it exists for.
    const doc = emptyDoc();
    applyToDoc(doc, [{ ...movie(550, SEC), watchedAt: ms(SEC) + 250 }], [], 1);
    applyToDoc(doc, [{ ...movie(550, SEC), watchedAt: ms(SEC) + 900 }], [], 2);
    expect(doc.titles["MOVIE|550"].w).toHaveLength(1);
  });
});

describe("deletion", () => {
  it("removes the watch and records a tombstone so other devices learn it", () => {
    const doc = emptyDoc();
    applyToDoc(doc, [movie(550, SEC)], [], 1);
    applyToDoc(doc, [{ ...movie(550, SEC), deletedAt: 9_999 }], [], 2);
    expect(doc.titles["MOVIE|550"]).toBeUndefined();
    expect(doc.deleted[`watch-MOVIE-550-${SEC}`]).toBe(9_999);
  });

  it("deletes one episode without touching its siblings", () => {
    const doc = emptyDoc();
    applyToDoc(doc, [ep(1396, 1, 1, SEC), ep(1396, 1, 2, SEC + 60)], [], 1);
    applyToDoc(doc, [{ ...ep(1396, 1, 1, SEC), deletedAt: 9_999 }], [], 2);
    expect(Object.keys(doc.titles["SHOW|1396"].eps!)).toEqual(["1x2"]);
  });

  it("keeps the title when a rating outlives the last watch", () => {
    // Dropping the entry here would silently discard a rating the user explicitly gave.
    const doc = emptyDoc();
    applyToDoc(doc, [movie(550, SEC)], [{ mediaType: "MOVIE", tmdbId: 550, rating: 9, updatedAt: 5 }], 1);
    applyToDoc(doc, [{ ...movie(550, SEC), deletedAt: 9_999 }], [], 2);
    expect(doc.titles["MOVIE|550"]).toMatchObject({ rating: 9 });
    expect(doc.titles["MOVIE|550"].w).toBeUndefined();
  });

  it("lets a re-watch clear its own tombstone", () => {
    // Deleting then re-marking is an ordinary thing to do. A permanent tombstone would
    // make that id un-re-addable forever and the re-watch would vanish with no error.
    const doc = emptyDoc();
    applyToDoc(doc, [{ ...movie(550, SEC), deletedAt: 9_999 }], [], 1);
    applyToDoc(doc, [movie(550, SEC)], [], 2);
    expect(doc.deleted[`watch-MOVIE-550-${SEC}`]).toBeUndefined();
    expect(doc.titles["MOVIE|550"].w).toHaveLength(1);
  });
});

describe("ratings", () => {
  it("takes the newer rating and ignores a stale one", () => {
    const doc = emptyDoc();
    applyToDoc(doc, [], [{ mediaType: "MOVIE", tmdbId: 550, rating: 9, updatedAt: 5_000 }], 1);
    applyToDoc(doc, [], [{ mediaType: "MOVIE", tmdbId: 550, rating: 3, updatedAt: 4_000 }], 2);
    expect(doc.titles["MOVIE|550"].rating).toBe(9);
  });

  it("compares the rating's own timestamp, not the sync's", () => {
    // An edit made offline last week must not beat one made on another device yesterday
    // purely because it reached the server later.
    const doc = emptyDoc();
    applyToDoc(doc, [], [{ mediaType: "SHOW", tmdbId: 1396, watchStatus: "COMPLETED", updatedAt: 9_000 }], 100);
    applyToDoc(doc, [], [{ mediaType: "SHOW", tmdbId: 1396, watchStatus: "DROPPED", updatedAt: 8_000 }], 200);
    expect(doc.titles["SHOW|1396"].status).toBe("COMPLETED");
  });

  it("attaches a rating to a title with no watches", () => {
    const doc = emptyDoc();
    applyToDoc(doc, [], [{ mediaType: "MOVIE", tmdbId: 550, rating: 7, updatedAt: 1 }], 1);
    expect(doc.titles["MOVIE|550"].rating).toBe(7);
    expect(statsFor(doc).eventCount).toBe(0);
  });
});

describe("derived counters", () => {
  it("counts events and titles, and reports the newest watch in millis", () => {
    const doc = emptyDoc();
    applyToDoc(doc, [ep(1396, 1, 1, SEC), ep(1396, 1, 2, SEC + 60), movie(550, SEC + 120)], [], 1);
    const s = statsFor(doc);
    expect(s).toMatchObject({ eventCount: 3, titleCount: 2 });
    expect(s.lastWatchedAt).toBe(ms(SEC + 120));
  });

  it("emits ONE analytics entry per title, carrying the count", () => {
    // The point of the batching: one data point per title per sync instead of one per
    // event. A 20k import becomes ~1,100 points, not 20,000.
    const doc = emptyDoc();
    applyToDoc(doc, [ep(1396, 1, 1, SEC), ep(1396, 1, 2, SEC + 60), movie(550, SEC)], [], 1);
    const { perTitle } = statsFor(doc);
    expect(perTitle).toHaveLength(2);
    expect(perTitle.find((t) => t.tmdbId === 1396)).toMatchObject({ mediaType: "SHOW", count: 2 });
    expect(perTitle.find((t) => t.tmdbId === 550)).toMatchObject({ mediaType: "MOVIE", count: 1 });
  });

  it("omits a rating-only title from the analytics entries", () => {
    const doc = emptyDoc();
    applyToDoc(doc, [], [{ mediaType: "MOVIE", tmdbId: 550, rating: 7, updatedAt: 1 }], 1);
    expect(statsFor(doc).perTitle).toHaveLength(0);
  });
});

describe("recent slice", () => {
  it("returns newest first across titles, capped", () => {
    const doc = emptyDoc();
    applyToDoc(doc, [ep(1396, 1, 1, SEC), movie(550, SEC + 500), ep(1396, 1, 2, SEC + 250)], [], 1);
    const recent = recentEvents(doc, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({ tmdbId: 550, season: null });
    expect(recent[1]).toMatchObject({ tmdbId: 1396, season: 1, episode: 2 });
  });
});

describe("serialisation", () => {
  it("round-trips through gzip", async () => {
    const doc = emptyDoc();
    applyToDoc(doc, [ep(1396, 2, 5, SEC), movie(550, SEC)], [{ mediaType: "MOVIE", tmdbId: 550, rating: 8, updatedAt: 1 }], 42);
    const back = await parseDoc(await serialiseDoc(doc));
    expect(back).toEqual(doc);
  });

  it("returns an empty document for unreadable bytes instead of throwing", async () => {
    // A corrupt object must not wedge a user's sync forever. The next push rebuilds it
    // from Room, which is the source of truth regardless.
    expect(await parseDoc(new TextEncoder().encode("not gzip at all").buffer)).toEqual(emptyDoc());
  });

  it("compresses a realistic history far below the raw form", async () => {
    const doc = emptyDoc();
    const events: IncomingEvent[] = [];
    for (let s = 1; s <= 8; s++) for (let e = 1; e <= 25; e++) events.push(ep(1396, s, e, SEC + s * 1000 + e));
    applyToDoc(doc, events, [], 1);
    const raw = new TextEncoder().encode(JSON.stringify(doc)).byteLength;
    const gz = (await serialiseDoc(doc)).byteLength;
    expect(statsFor(doc).eventCount).toBe(200);
    expect(gz).toBeLessThan(raw / 2);
  });
});

describe("tombstones identify their watch by ID, not by payload", () => {
  // The client cannot describe the row it just deleted — it is gone. It sends the id and
  // fills the rest with placeholders. Live 2026-08-03: trusting those placeholders left the
  // document holding a tombstone AND the watch, and event_count ROSE on a deletion.
  const tombstone = (id: string, at = 5_000) => ({
    id,
    mediaType: id.includes("-MOVIE-") ? "MOVIE" : "SHOW",
    tmdbId: 1, // ← placeholder the client actually sends
    watchedAt: at, // ← the DELETION time, not the watch second
    deletedAt: at,
  });

  it("removes the movie watch the tombstone refers to", () => {
    const doc = applyToDoc(emptyDoc(), [
      { id: "watch-MOVIE-550-1753027200", mediaType: "MOVIE", tmdbId: 550, watchedAt: 1753027200_000 },
    ], [], 1);
    expect(statsFor(doc).eventCount).toBe(1);

    applyToDoc(doc, [tombstone("watch-MOVIE-550-1753027200")], [], 2);
    expect(doc.titles["MOVIE|550"]).toBeUndefined();
    expect(statsFor(doc).eventCount).toBe(0);
    expect(doc.deleted["watch-MOVIE-550-1753027200"]).toBe(5_000);
    // The placeholder tmdbId must not have created a phantom title.
    expect(doc.titles["MOVIE|1"]).toBeUndefined();
  });

  it("removes the episode watch the tombstone refers to", () => {
    const doc = applyToDoc(emptyDoc(), [
      { id: "watch-EPISODE-1396-s2e5-1753027200", mediaType: "SHOW", tmdbId: 1396,
        seasonNumber: 2, episodeNumber: 5, watchedAt: 1753027200_000 },
    ], [], 1);
    applyToDoc(doc, [tombstone("watch-EPISODE-1396-s2e5-1753027200")], [], 2);
    expect(statsFor(doc).eventCount).toBe(0);
    expect(doc.titles["SHOW|1396"]).toBeUndefined();
  });

  it("keeps a rating when its only watch is tombstoned", () => {
    const doc = applyToDoc(
      emptyDoc(),
      [{ id: "watch-MOVIE-550-1753027200", mediaType: "MOVIE", tmdbId: 550, watchedAt: 1753027200_000 }],
      [{ mediaType: "MOVIE", tmdbId: 550, rating: 9, updatedAt: 1 }],
      1,
    );
    applyToDoc(doc, [tombstone("watch-MOVIE-550-1753027200")], [], 2);
    expect(doc.titles["MOVIE|550"]?.rating).toBe(9);
    expect(doc.titles["MOVIE|550"]?.w).toBeUndefined();
  });

  it("heals a document already corrupted by the old behaviour", () => {
    // The stale tombstone never arrives again — it left the outbox long ago — so without a
    // repair pass these documents stay wrong forever, and the Phase 4 tombstone sweep would
    // then resurrect the deleted watch on every device.
    const doc = emptyDoc();
    doc.titles["MOVIE|550"] = { w: [[1753027200, 100, "TRAKT"]] };
    doc.deleted["watch-MOVIE-550-1753027200"] = 5_000;

    applyToDoc(doc, [], [], 9);
    expect(doc.titles["MOVIE|550"]).toBeUndefined();
    expect(statsFor(doc).eventCount).toBe(0);
  });

  it("a re-watch still resurrects the id, and is not undone by the repair pass", () => {
    const live = { id: "watch-MOVIE-550-1753027200", mediaType: "MOVIE", tmdbId: 550, watchedAt: 1753027200_000 };
    const doc = applyToDoc(emptyDoc(), [live], [], 1);
    applyToDoc(doc, [tombstone("watch-MOVIE-550-1753027200")], [], 2);
    expect(statsFor(doc).eventCount).toBe(0);

    applyToDoc(doc, [live], [], 3);
    expect(statsFor(doc).eventCount).toBe(1);
    expect(doc.deleted["watch-MOVIE-550-1753027200"]).toBeUndefined();
  });

  it("an unparseable id still records the tombstone rather than throwing", () => {
    const doc = emptyDoc();
    applyToDoc(doc, [{ ...tombstone("legacy-id-shape"), mediaType: "MOVIE" }], [], 2);
    expect(doc.deleted["legacy-id-shape"]).toBe(5_000);
  });
});
