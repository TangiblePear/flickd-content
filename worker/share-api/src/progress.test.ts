import { describe, expect, it } from "vitest";
import { digestFrom } from "./progress";
import type { HistoryDoc } from "./historyDoc";

/** Watches are stored in SECONDS; only the first slot is read for recency. */
const w = (epochSeconds: number) => [epochSeconds, 100, "MANUAL"] as [number, number, string];

const doc = (titles: HistoryDoc["titles"]): HistoryDoc => ({
  v: 1,
  titles,
  deleted: {},
  updatedAt: 0,
  ver: 7,
});

describe("digestFrom", () => {
  it("counts distinct episodes, not rewatches", () => {
    // The count is compared against an AIRED-episode total on the client, so counting a
    // rewatch would push a partly-watched show over the line and read as "Completed".
    const d = digestFrom(
      doc({
        "SHOW|1396": { eps: { "1x1": [w(100), w(200), w(300)], "1x2": [w(400)] } },
      }),
    );
    expect(d.t["SHOW|1396"][0]).toBe(2);
  });

  it("takes the furthest episode by (season, episode), not by watch time", () => {
    // The trap this pins: a binge drop stamps one timestamp across a whole season, so a
    // time-ordered max picks an arbitrary episode within it. Here the LATEST-watched
    // episode is deliberately the earliest one.
    const d = digestFrom(
      doc({
        "SHOW|1396": {
          eps: {
            "2x8": [w(100)],
            "3x1": [w(100)],
            "1x1": [w(999999)],
          },
        },
      }),
    );
    const [, season, episode] = d.t["SHOW|1396"];
    expect([season, episode]).toEqual([3, 1]);
  });

  it("never advances the marker on a special", () => {
    // "Up to S0 E3" is not progress, and a special watched late would otherwise outrank
    // the real furthest episode.
    const d = digestFrom(
      doc({ "SHOW|1396": { eps: { "1x4": [w(100)], "0x3": [w(500)] } } }),
    );
    const [count, season, episode] = d.t["SHOW|1396"];
    expect([season, episode]).toEqual([1, 4]);
    // ...but it still counts as watched.
    expect(count).toBe(2);
  });

  it("reports the most recent watch in millis", () => {
    const d = digestFrom(doc({ "SHOW|1396": { eps: { "1x1": [w(100), w(4200)] } } }));
    expect(d.t["SHOW|1396"][3]).toBe(4200 * 1000);
  });

  it("packs a film with zeroed season and episode", () => {
    const d = digestFrom(doc({ "MOVIE|550": { w: [w(300), w(900)] } }));
    expect(d.t["MOVIE|550"]).toEqual([2, 0, 0, 900 * 1000]);
  });

  it("omits a title carrying only a rating or status", () => {
    // A rating is an explicit user action with no viewing behind it. Publishing it as
    // progress would tell friends someone watched something they did not.
    const d = digestFrom(
      doc({
        "MOVIE|550": { rating: 9, status: "WANT_TO_WATCH", rAt: 5 },
        "MOVIE|551": { w: [w(1)] },
      }),
    );
    expect(d.t["MOVIE|550"]).toBeUndefined();
    expect(d.t["MOVIE|551"]).toBeDefined();
  });

  it("carries the document version so readers can gate on it", () => {
    expect(digestFrom(doc({})).ver).toBe(7);
  });

  it("survives a malformed episode key without dropping the title", () => {
    const d = digestFrom(doc({ "SHOW|1396": { eps: { "not-a-key": [w(10)], "1x1": [w(20)] } } }));
    expect(d.t["SHOW|1396"][0]).toBe(2);
    expect([d.t["SHOW|1396"][1], d.t["SHOW|1396"][2]]).toEqual([1, 1]);
  });
});
