import { describe, expect, it } from "vitest";
import { BETA_CUTOFF_MS, handlePutInstall, isBetaTester } from "./install";

const USER = "AAAAH73X7P55T48R4CFHDED9CW";

/**
 * D1 double that actually applies the CASE merge, because the merge IS the feature —
 * a fake that just records the statement would pass while storing the wrong date.
 */
function fakeDb(initial: { first_install_at: number; beta_tester: number }) {
  const row = { ...initial };
  return {
    row,
    prepare(sql: string) {
      const stmt: any = {
        args: [] as any[],
        bind(...a: any[]) {
          stmt.args = a;
          return stmt;
        },
        async first() {
          if (sql.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
            return { user_id: USER, expires_at: Date.now() + 8.64e7, revoked_at: null };
          }
          return { ...row };
        },
        async run() {
          const [a, , , , cutoff] = stmt.args as number[];
          const merged = row.first_install_at === 0 || a < row.first_install_at ? a : row.first_install_at;
          row.first_install_at = merged;
          // Derived from MERGED, matching the statement. A fake that used the reported
          // value here would have gone green on the bug a real device found.
          if (row.beta_tester !== 1) row.beta_tester = merged < cutoff ? 1 : 0;
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

const post = (body: unknown) =>
  new Request("https://flickto.app/api/me/install", {
    method: "POST",
    headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const JULY_20 = 1784592000000; // before the cutoff
const AUG_05 = 1785888000000; // after it

describe("POST /api/me/install", () => {
  it("stores a first report and derives the beta latch from it", async () => {
    const db = fakeDb({ first_install_at: 0, beta_tester: 0 });
    const res = await handlePutInstall(post({ firstInstallAt: JULY_20 }), { DB: db } as any);
    expect(await res.json()).toEqual({ firstInstallAt: JULY_20, betaTester: true });
  });

  it("does not award beta to an August install", async () => {
    const db = fakeDb({ first_install_at: 0, beta_tester: 0 });
    await handlePutInstall(post({ firstInstallAt: AUG_05 }), { DB: db } as any);
    expect(db.row.beta_tester).toBe(0);
    expect(db.row.first_install_at).toBe(AUG_05);
  });

  /**
   * The reinstall case, and the reason the merge is MIN. Taking the newest report would
   * let someone destroy their own history by clearing app data.
   */
  it("only ever moves the date EARLIER", async () => {
    const db = fakeDb({ first_install_at: JULY_20, beta_tester: 1 });
    await handlePutInstall(post({ firstInstallAt: AUG_05 }), { DB: db } as any);
    expect(db.row.first_install_at).toBe(JULY_20);

    const earlier = JULY_20 - 30 * 86_400_000;
    await handlePutInstall(post({ firstInstallAt: earlier }), { DB: db } as any);
    expect(db.row.first_install_at).toBe(earlier);
  });

  /** A reinstall in September has no early date left to prove it with. It keeps the badge. */
  it("never revokes the beta latch once set", async () => {
    const db = fakeDb({ first_install_at: JULY_20, beta_tester: 1 });
    await handlePutInstall(post({ firstInstallAt: AUG_05 }), { DB: db } as any);
    expect(db.row.beta_tester).toBe(1);
    expect(isBetaTester(db.row)).toBe(true);
  });

  it("rejects dates that are not evidence of anything", async () => {
    const db = fakeDb({ first_install_at: 0, beta_tester: 0 });
    for (const bad of [0, -1, Date.now() + 86_400_000, 1_000_000, "yesterday", null, undefined]) {
      const res = await handlePutInstall(post({ firstInstallAt: bad }), { DB: db } as any);
      expect(res.status).toBe(400);
    }
    // Nothing was written by any of them.
    expect(db.row.first_install_at).toBe(0);
  });

  it("the cutoff is the documented one", () => {
    expect(BETA_CUTOFF_MS).toBe(Date.UTC(2026, 7, 1));
  });

  /**
   * The case a real device found. A phone reinstalled in August reports August, while the
   * account already knew about July — and it is the ACCOUNT's knowledge the rule is about.
   * Deriving beta from the report alone silently denied a badge that had been earned.
   */
  it("derives beta from the merged date, not the reported one", async () => {
    const db = fakeDb({ first_install_at: JULY_20, beta_tester: 0 });
    const res = await handlePutInstall(post({ firstInstallAt: AUG_05 }), { DB: db } as any);
    expect(db.row.first_install_at).toBe(JULY_20);
    expect(db.row.beta_tester).toBe(1);
    expect(await res.json()).toEqual({ firstInstallAt: JULY_20, betaTester: true });
  });
});
