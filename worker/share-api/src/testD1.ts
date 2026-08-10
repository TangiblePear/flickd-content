// ── A real-SQLite D1 double, for tests only ──────────────────────────────────
//
// Not imported by any handler, so it never reaches the bundle.
//
// **Why this exists.** Every other suite here hand-writes a D1 double that matches SQL by
// `startsWith` and returns a canned shape. That is fine for a module issuing two
// statements, and it actively misleads for one issuing thirty: a string-matching double
// proves the handler called *something*, never that the SQL is correct. It cannot catch a
// wrong JOIN, a GROUP BY that halves a count, a `json_array_length` against a column that
// is not an array, or a LEFT JOIN that fans out and duplicates rows — which are exactly
// the mistakes usersAdmin.ts is able to make.
//
// It also has a maintenance cost that already bit: friends.test.ts's double matched the
// friend-card query by spelling out every column, so adding one broke three tests about
// something else entirely.
//
// So this runs the statements against a real SQLite database built from the REAL migration
// files. Node 24 ships `node:sqlite`, and the migrations already replay cleanly (verified
// when 0031 landed), so the schema under test is production's schema rather than a
// hand-copied subset that drifts.
//
// ⚠️ It is SQLite, not D1. Known divergences: D1 enforces no foreign keys the way this
// does not, `batch()` here is sequential rather than a single transaction, and D1's
// `json_*` build could in principle differ. None of those affect what these suites assert,
// but a test that starts depending on transactional rollback is testing this file, not D1.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// ⚠️ Required at RUNTIME rather than imported.
//
// `node:sqlite` is newer than this Vite's list of Node builtins, so a static
// `import ... from "node:sqlite"` has its prefix stripped and is resolved as a package
// called "sqlite", which does not exist — the suite then fails at COLLECTION with
// "Failed to load url sqlite", before a single test runs. Externalising it via
// `test.server.deps.external` does not help; the resolution happens earlier.
//
// A `createRequire` call is opaque to the bundler, so the specifier reaches Node intact.
// Node 22+ only, which is satisfied here (24.x).
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
};

/** The slice of node:sqlite's DatabaseSync this file uses. */
interface DatabaseSyncLike {
  prepare(sql: string): { get(...a: never[]): unknown; all(...a: never[]): unknown[]; run(...a: never[]): unknown };
  exec(sql: string): void;
}

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

/** Column-name → value, as D1 hands rows back. */
type Row = Record<string, unknown>;

class Stmt {
  private args: unknown[] = [];
  constructor(
    private db: DatabaseSyncLike,
    private sql: string,
  ) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T = Row>(): Promise<T | null> {
    // `?1`-style numbered parameters appear in a few queries. node:sqlite binds them
    // positionally from the same array, so nothing special is needed — but a query using
    // ?1 twice passes ONE argument, which is exactly why those call sites bind once.
    const row = this.db.prepare(this.sql).get(...(this.args as never[]));
    return (row as T) ?? null;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true }> {
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[], success: true };
  }

  async run(): Promise<{ success: true }> {
    this.db.prepare(this.sql).run(...(this.args as never[]));
    return { success: true };
  }
}

export class TestD1 {
  readonly sqlite: DatabaseSyncLike;

  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    }
  }

  prepare(sql: string): Stmt {
    return new Stmt(this.sqlite, sql);
  }

  /** Sequential, not transactional — see the divergence note above. */
  async batch(stmts: Stmt[]): Promise<Array<{ success: true }>> {
    const out: Array<{ success: true }> = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }

  /** Raw escape hatch for arranging fixtures and asserting on final state. */
  exec(sql: string): void {
    this.sqlite.exec(sql);
  }

  rows<T = Row>(sql: string, ...args: unknown[]): T[] {
    return this.sqlite.prepare(sql).all(...(args as never[])) as T[];
  }

  one<T = Row>(sql: string, ...args: unknown[]): T | null {
    return (this.sqlite.prepare(sql).get(...(args as never[])) as T) ?? null;
  }

  count(table: string, where = "1=1", ...args: unknown[]): number {
    const r = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...args);
    return r?.n ?? 0;
  }
}

// ── Fixture helpers ──────────────────────────────────────────────────────────
// Deliberately explicit rather than clever: a test that has to read a factory to know what
// it arranged is a test whose failure is hard to interpret.

/** A valid-shaped account id — 26 chars of Crockford base32, which the detail route matches. */
export const uid = (n: number): string => `AAAAH73X7P55T48R4CFHDED${String(n).padStart(3, "0")}`.slice(0, 26);

export interface SeedUser {
  id: string;
  createdAt?: number;
  status?: string;
  premiereUntil?: number;
  premiereCompUntil?: number;
  postingSuspendedUntil?: number | null;
  betaTester?: number;
  email?: string | null;
  displayName?: string | null;
}

export function seedUser(db: TestD1, u: SeedUser): string {
  const now = u.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO users (id, created_at, status, premiere_until, premiere_comp_until,
                        posting_suspended_until, beta_tester)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      u.id,
      now,
      u.status ?? "active",
      u.premiereUntil ?? 0,
      u.premiereCompUntil ?? 0,
      u.postingSuspendedUntil ?? null,
      u.betaTester ?? 0,
    )
    .run();
  if (u.email !== null) {
    db.prepare("INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("firebase", `uid-${u.id}`, u.id, u.email ?? `${u.id}@example.com`, now)
      .run();
  }
  if (u.displayName !== null) {
    db.prepare("INSERT INTO profiles (user_id, display_name, updated_at, version) VALUES (?, ?, ?, 1)")
      .bind(u.id, u.displayName ?? `User ${u.id.slice(0, 4)}`, now)
      .run();
  }
  return u.id;
}

export interface SeedDevice {
  userId: string;
  deviceId?: string;
  platform?: string;
  versionCode?: number;
  versionName?: string | null;
  buildType?: string | null;
  lastSeenAt?: number;
  manufacturer?: string | null;
  model?: string | null;
  country?: string | null;
  premium?: number | null;
  integrations?: Record<string, unknown> | null;
  watched?: number | null;
}

export function seedDevice(db: TestD1, d: SeedDevice): void {
  const seen = d.lastSeenAt ?? Date.now();
  db.prepare(
    `INSERT INTO user_telemetry (user_id, device_id, platform, version_code, country, last_seen_at,
                                 reported_on, version_name, build_type, manufacturer, model,
                                 premium, integrations, features)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      d.userId,
      d.deviceId ?? "d".repeat(64),
      d.platform ?? "android",
      d.versionCode ?? 100,
      d.country ?? "GB",
      seen,
      new Date(seen).toISOString().slice(0, 10),
      d.versionName === undefined ? "2.4.1" : d.versionName,
      d.buildType === undefined ? "release" : d.buildType,
      d.manufacturer === undefined ? "Google" : d.manufacturer,
      d.model === undefined ? "Pixel 8" : d.model,
      d.premium ?? null,
      d.integrations === undefined ? null : d.integrations && JSON.stringify(d.integrations),
      d.watched == null ? null : JSON.stringify({ used: ["discover"], counts: { watched: d.watched } }),
    )
    .run();
}

/** A session that resolves, so `revokeAllSessions` has something to end. */
export function seedSession(db: TestD1, userId: string, tokenHash: string, revoked = false): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(tokenHash, userId, now, now + 90 * 86_400_000, revoked ? now : null)
    .run();
}

/** An admin-authorised request. `ADMIN_KEY` in [env] must match. */
export const adminReq = (url: string, key = "test-admin-key", init: RequestInit = {}): Request =>
  new Request(`https://flickto.app${url}`, {
    ...init,
    headers: { "X-Admin-Key": key, "X-Admin-Actor": "tester", ...(init.headers as Record<string, string>) },
  });

export const adminPost = (url: string, body: unknown, key = "test-admin-key"): Request =>
  adminReq(url, key, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

export function testEnv(db: TestD1, over: Record<string, unknown> = {}) {
  return { DB: db, ADMIN_KEY: "test-admin-key", ...over } as never;
}
