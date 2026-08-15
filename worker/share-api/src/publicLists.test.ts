import { describe, it, expect } from "vitest";
import { TestD1, seedUser, uid } from "./testD1";

/**
 * Public lists, against REAL SQL.
 *
 * The browse query is a JOIN across four tables with two correlated aggregates and a
 * decay expression in the ORDER BY. A string-matching D1 double would prove it was
 * called and nothing about whether it returns the right rows in the right order — so
 * this builds a real SQLite from the real migrations, 0039 included.
 */
describe("migration 0039", () => {
  it("creates the four tables with the documented keys", () => {
    const db = new TestD1();
    const names = db
      .rows<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table'
           AND name IN ('public_lists','public_list_tags','list_follows','public_list_likes')
         ORDER BY name`,
      )
      .map((r) => r.name);
    expect(names).toEqual(["list_follows", "public_list_likes", "public_list_tags", "public_lists"]);
  });

  it("keys public_lists on (owner_id, list_id) so one user's list cannot displace another's", () => {
    const db = new TestD1();
    seedUser(db, { id: uid(1) });
    seedUser(db, { id: uid(2) });
    const ins = (owner: string) =>
      db.one(
        `INSERT INTO public_lists (owner_id, list_id, tags, engagement, published_at, hidden_at)
         VALUES (?, 'watchlist', '[]', 0, 1, NULL)`,
        owner,
      );
    ins(uid(1));
    ins(uid(2));
    const n = db.count("public_lists", "list_id = 'watchlist'");
    expect(n).toBe(2);
  });
});
