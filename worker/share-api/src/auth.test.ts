import { describe, it, expect, beforeAll } from "vitest";
import {
  extractSpkiFromCertificate,
  pemToDer,
  verifyFirebaseIdToken,
  handleAuthSession,
  handleAuthLogout,
  handleAuthProbe,
  resolveSession,
  revokeAllSessions,
  __setKeyCacheForTest,
} from "./auth";
import worker from "./index";
// The probe tests use the real-SQLite shim rather than the hand-written FakeD1 below.
// That fake interprets the exact statements auth.ts issues, so it can only ever confirm
// that a handler called something it already knows about — a LEFT JOIN against real
// migrations is precisely the thing it cannot check.
import { TestD1 } from "./testD1";

const PROJECT_ID = "flickto-cf7b6";
const ISS = `https://securetoken.google.com/${PROJECT_ID}`;
const KID = "test-kid-1";

// A real certificate captured from
// https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com
// on 2026-07-26. Only used to exercise the DER→SPKI walk against genuine input;
// it will expire and that is fine — nothing here verifies a signature with it.
const REAL_FIREBASE_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIIFFdImQ/V0kUwDQYJKoZIhvcNAQEFBQAwMTEvMC0GA1UE
Awwmc2VjdXJldG9rZW4uc3lzdGVtLmdzZXJ2aWNlYWNjb3VudC5jb20wHhcNMjYw
NTA0MTc0NzI3WhcNMjcwNTA0MTc0NzI3WjAxMS8wLQYDVQQDDCZzZWN1cmV0b2tl
bi5zeXN0ZW0uZ3NlcnZpY2VhY2NvdW50LmNvbTCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAOKOpTkKGfjHH1ny5ZJXKag63eWg9RvVlfY3SgKULip4mwM1
HuCIY0aYoXEdKdVFgS/+mPOPDfSSjcYbl1/+QTZH0mBiqatIgQGegNf5naIkF9jd
SxazYShP8cgjOkRckaFdrMvEa/mNOO5wTk6AEMbUR+V1M8auOAiqeAGOvTTgbOJl
bRB9NufzI8WbysbEPRtgqDYY9WxXcrukkacecYsaLkj0qy14DTZXt08NB+ZlYnHQ
2+qoEo33lMMm67gpBTPe3mu4L9CrZ9qDxzH7WqMz+7zGeA9FqDwyMu9UONE+Ssbs
xYN6dtw12vC1S6ueAzdGgWCOTB8njBAvkrYJ0gMCAwEAAaM4MDYwDAYDVR0TAQH/
BAIwADAOBgNVHQ8BAf8EBAMCB4AwFgYDVR0lAQH/BAwwCgYIKwYBBQUHAwIwDQYJ
KoZIhvcNAQEFBQADggEBALxRVxyzG7sUYwBdUGOQ8wWt7o/1tvgAVKa9VpgzzlHb
W4irMEOCetKswJFN4KieFqfUcwsKucRiDZRm9iIrPTyI3AhH9Yu7UY7lrqkYZ//b
v1Q+oj1YqYcwHcyhuykzQIf+eq1reBWhG0GaDfxTdIeQkcYBZ5nVNICBXU2QVJLE
qjM89ncbpinVTzI7kH1uZvqMDeL7/su6GSvoi4oXokOauGcaogwbbE+HK//QMOMK
XSu2FfrwU5Vua5Mx37jQTnM5ruVJQvnNYsd9QAMfhd7cUMMYuIAW1sQMSk5/F95Q
QCCW8kDKq9yAOrfHSS2zw5pqsIc/HC/bD3cW9J0CYK8=
-----END CERTIFICATE-----`;

// ── JWT helpers ──────────────────────────────────────────────────────────────
let signKey: CryptoKey;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
const b64urlStr = (str: string) => b64url(new TextEncoder().encode(str));

async function makeToken(
  claims: Record<string, unknown>,
  opts: { kid?: string; alg?: string; sign?: boolean } = {},
): Promise<string> {
  const header = b64urlStr(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" }));
  const payload = b64urlStr(JSON.stringify(claims));
  if (opts.sign === false) return `${header}.${payload}.`;
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signKey, new TextEncoder().encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

const secs = () => Math.floor(Date.now() / 1000);
const validClaims = (over: Record<string, unknown> = {}) => ({
  iss: ISS,
  aud: PROJECT_ID,
  sub: "firebase-uid-1",
  email: "someone@example.com",
  iat: secs() - 60,
  exp: secs() + 3600,
  ...over,
});

// ── In-memory D1 fake ────────────────────────────────────────────────────────
// No such helper exists in the other test files (only a FakeBucket in
// account.test.ts), so this is the first one. It interprets exactly the
// statements auth.ts issues.
interface UserRow {
  id: string;
  created_at: number;
  status: string;
}
interface IdentityRow {
  provider: string;
  subject: string;
  user_id: string;
  email: string | null;
  created_at: number;
}
interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

class FakeD1 {
  users: UserRow[] = [];
  identities: IdentityRow[] = [];
  sessions: SessionRow[] = [];
  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
  async batch(stmts: FakeStmt[]) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

class FakeStmt {
  private args: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    const s = this.sql;
    if (s.includes("FROM identities")) {
      const [provider, subject] = this.args as [string, string];
      const row = this.db.identities.find((i) => i.provider === provider && i.subject === subject);
      return row ? ({ user_id: row.user_id } as T) : null;
    }
    if (s.includes("FROM users")) {
      const row = this.db.users.find((u) => u.id === this.args[0]);
      return row ? ({ status: row.status } as T) : null;
    }
    if (s.includes("FROM sessions")) {
      const row = this.db.sessions.find((x) => x.token_hash === this.args[0]);
      return row ? ({ user_id: row.user_id, expires_at: row.expires_at, revoked_at: row.revoked_at } as T) : null;
    }
    throw new Error(`FakeD1: unhandled first() for ${s}`);
  }
  async run() {
    const s = this.sql;
    if (s.startsWith("INSERT INTO users")) {
      const [id, created_at] = this.args as [string, number];
      this.db.users.push({ id, created_at, status: "active" });
    } else if (s.startsWith("INSERT INTO identities")) {
      const [provider, subject, user_id, email, created_at] = this.args as [string, string, string, string | null, number];
      this.db.identities.push({ provider, subject, user_id, email, created_at });
    } else if (s.startsWith("INSERT INTO sessions")) {
      const [token_hash, user_id, created_at, expires_at] = this.args as [string, string, number, number];
      this.db.sessions.push({ token_hash, user_id, created_at, expires_at, revoked_at: null });
    } else if (s.startsWith("UPDATE sessions SET revoked_at") && !s.includes("token_hash")) {
      // `revokeAllSessions` — every live session for one user, in one statement. No
      // token_hash, which is what distinguishes it from the two by-hash shapes below.
      const [revoked_at, user_id] = this.args as [number, string];
      for (const row of this.db.sessions) {
        if (row.user_id === user_id && row.revoked_at == null) row.revoked_at = revoked_at;
      }
    } else if (s.startsWith("UPDATE sessions SET revoked_at")) {
      // Two shapes: logout revokes by hash alone; the session-mint path also
      // scopes to user_id so a Firebase token can't revoke another user's session.
      const [revoked_at, token_hash] = this.args as [number, string];
      const scopedUserId = s.includes("user_id = ?") ? (this.args[2] as string) : null;
      const row = this.db.sessions.find(
        (x) => x.token_hash === token_hash && x.revoked_at == null && (scopedUserId == null || x.user_id === scopedUserId),
      );
      if (row) row.revoked_at = revoked_at;
    } else if (s.startsWith("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?")) {
      const [user_id, cutoff] = this.args as [string, number];
      this.db.sessions = this.db.sessions.filter((x) => !(x.user_id === user_id && x.expires_at <= cutoff));
    } else {
      throw new Error(`FakeD1: unhandled run() for ${s}`);
    }
    return { success: true };
  }
  async all() {
    const s = this.sql;
    if (s.startsWith("SELECT token_hash FROM sessions")) {
      const [user_id] = this.args as [string];
      return {
        results: this.db.sessions
          .filter((x) => x.user_id === user_id && x.revoked_at == null)
          .map((x) => ({ token_hash: x.token_hash })),
        success: true,
      };
    }
    return { results: [], success: true };
  }
}

const makeEnv = (over: Record<string, unknown> = {}) =>
  ({ DB: new FakeD1(), FIREBASE_PROJECT_ID: PROJECT_ID, ...over }) as any;

const bearerReq = (token: string, url = "https://flickto.app/api/auth/session") =>
  new Request(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  signKey = pair.privateKey;
  __setKeyCacheForTest(new Map([[KID, pair.publicKey]]));
});

// ── DER → SPKI ───────────────────────────────────────────────────────────────
describe("extractSpkiFromCertificate", () => {
  it("produces SPKI bytes that importKey('spki') accepts, from a real Firebase cert", async () => {
    const spki = extractSpkiFromCertificate(pemToDer(REAL_FIREBASE_CERT_PEM));
    expect(spki[0]).toBe(0x30); // SEQUENCE
    const key = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    expect(key.algorithm.name).toBe("RSASSA-PKCS1-v1_5");
    expect((key.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(2048);
  });

  it("returns the SPKI, not the whole certificate", () => {
    const der = pemToDer(REAL_FIREBASE_CERT_PEM);
    const spki = extractSpkiFromCertificate(der);
    expect(spki.length).toBeLessThan(der.length);
    expect(spki.length).toBe(294);
  });

  it("throws on non-certificate DER", () => {
    expect(() => extractSpkiFromCertificate(new Uint8Array([0x02, 0x01, 0x05]))).toThrow();
  });
});

// ── Token verification ───────────────────────────────────────────────────────
describe("verifyFirebaseIdToken", () => {
  it("accepts a valid token and returns uid + email", async () => {
    expect(await verifyFirebaseIdToken(await makeToken(validClaims()), makeEnv())).toEqual({
      uid: "firebase-uid-1",
      email: "someone@example.com",
    });
  });

  it("accepts a token with no email claim", async () => {
    const t = await makeToken(validClaims({ email: undefined }));
    expect(await verifyFirebaseIdToken(t, makeEnv())).toEqual({ uid: "firebase-uid-1" });
  });

  it("accepts a token with no auth_time claim", async () => {
    const claims = validClaims();
    expect(await verifyFirebaseIdToken(await makeToken(claims), makeEnv())).not.toBeNull();
  });

  it("rejects an expired exp", async () => {
    expect(await verifyFirebaseIdToken(await makeToken(validClaims({ exp: secs() - 60 })), makeEnv())).toBeNull();
  });

  it("rejects an iat in the future", async () => {
    expect(await verifyFirebaseIdToken(await makeToken(validClaims({ iat: secs() + 600 })), makeEnv())).toBeNull();
  });

  it("rejects a wrong aud", async () => {
    expect(await verifyFirebaseIdToken(await makeToken(validClaims({ aud: "some-other-project" })), makeEnv())).toBeNull();
  });

  it("rejects the project NUMBER as aud", async () => {
    expect(await verifyFirebaseIdToken(await makeToken(validClaims({ aud: "468641021144" })), makeEnv())).toBeNull();
  });

  it("rejects a wrong iss", async () => {
    const t = await makeToken(validClaims({ iss: "https://securetoken.google.com/someone-else" }));
    expect(await verifyFirebaseIdToken(t, makeEnv())).toBeNull();
  });

  it("rejects an unknown kid", async () => {
    expect(await verifyFirebaseIdToken(await makeToken(validClaims(), { kid: "nope" }), makeEnv())).toBeNull();
  });

  it("rejects alg: none (algorithm confusion)", async () => {
    const t = await makeToken(validClaims(), { alg: "none", sign: false });
    expect(await verifyFirebaseIdToken(t, makeEnv())).toBeNull();
  });

  it("rejects alg: HS256 (algorithm confusion)", async () => {
    const t = await makeToken(validClaims(), { alg: "HS256" });
    expect(await verifyFirebaseIdToken(t, makeEnv())).toBeNull();
  });

  it("rejects a missing sub", async () => {
    expect(await verifyFirebaseIdToken(await makeToken(validClaims({ sub: undefined })), makeEnv())).toBeNull();
  });

  it("rejects an empty sub", async () => {
    expect(await verifyFirebaseIdToken(await makeToken(validClaims({ sub: "" })), makeEnv())).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const t = await makeToken(validClaims());
    expect(await verifyFirebaseIdToken(t.slice(0, -3) + (t.slice(-3) === "AAA" ? "BBB" : "AAA"), makeEnv())).toBeNull();
  });

  it("rejects anything that is not a three-part JWT", async () => {
    expect(await verifyFirebaseIdToken("not-a-jwt", makeEnv())).toBeNull();
    expect(await verifyFirebaseIdToken("", makeEnv())).toBeNull();
  });

  it("returns null when FIREBASE_PROJECT_ID is unset", async () => {
    const t = await makeToken(validClaims());
    expect(await verifyFirebaseIdToken(t, makeEnv({ FIREBASE_PROJECT_ID: undefined }))).toBeNull();
  });
});

// ── Sessions ─────────────────────────────────────────────────────────────────
describe("session lifecycle", () => {
  it("mints a session, resolves it, then rejects it after logout", async () => {
    const env = makeEnv();
    const res = await handleAuthSession(bearerReq(await makeToken(validClaims())), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.sessionToken).toBe("string");
    expect(body.sessionToken.length).toBeGreaterThan(40);
    expect(body.userId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // epoch MILLISECONDS, 90 days out
    expect(body.expiresAt).toBeGreaterThan(Date.now() + 89 * 86400_000);
    expect(body.expiresAt).toBeLessThan(Date.now() + 91 * 86400_000);
    // never stores the raw token
    expect(env.DB.sessions[0].token_hash).not.toBe(body.sessionToken);
    expect(env.DB.sessions[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
    // and never stores the Firebase uid as the user id
    expect(body.userId).not.toBe("firebase-uid-1");
    expect(env.DB.identities[0].subject).toBe("firebase-uid-1");
    expect(env.DB.identities[0].email).toBe("someone@example.com");

    const sessionReq = bearerReq(body.sessionToken);
    expect(await resolveSession(sessionReq, env)).toEqual({ userId: body.userId });

    const out = await handleAuthLogout(bearerReq(body.sessionToken, "https://flickto.app/api/auth/logout"), env);
    expect(out.status).toBe(204);
    expect(await out.text()).toBe("");
    expect(await resolveSession(sessionReq, env)).toBeNull();
  });

  it("reuses the same userId for a repeat sign-in with the same uid", async () => {
    const env = makeEnv();
    const a = (await (await handleAuthSession(bearerReq(await makeToken(validClaims())), env)).json()) as any;
    const b = (await (await handleAuthSession(bearerReq(await makeToken(validClaims())), env)).json()) as any;
    expect(b.userId).toBe(a.userId);
    expect(b.sessionToken).not.toBe(a.sessionToken);
    expect(env.DB.users.length).toBe(1);
    expect(env.DB.sessions.length).toBe(2);
    // The registration signal. Google is the only provider, so these two calls are
    // identical in every other respect — `created` is the ONLY thing that tells the
    // web it just made an account rather than resumed one.
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
  });

  // The helper a ban depends on. `resolveSession` never re-reads `users`, so flipping
  // `users.status` alone leaves every existing session working for its full 90 days —
  // a ban that does nothing and reports success.
  describe("revokeAllSessions", () => {
    it("ends every live session for one user and reports how many", async () => {
      const env = makeEnv();
      const a = (await (await handleAuthSession(bearerReq(await makeToken(validClaims())), env)).json()) as any;
      const b = (await (await handleAuthSession(bearerReq(await makeToken(validClaims())), env)).json()) as any;
      expect(await resolveSession(bearerReq(a.sessionToken), env)).not.toBeNull();
      expect(await resolveSession(bearerReq(b.sessionToken), env)).not.toBeNull();

      expect(await revokeAllSessions(env, a.userId)).toBe(2);

      expect(await resolveSession(bearerReq(a.sessionToken), env)).toBeNull();
      expect(await resolveSession(bearerReq(b.sessionToken), env)).toBeNull();
      expect(env.DB.sessions.every((s: any) => s.revoked_at != null)).toBe(true);
    });

    it("leaves other accounts alone", async () => {
      const env = makeEnv();
      const mine = (await (await handleAuthSession(bearerReq(await makeToken(validClaims())), env)).json()) as any;
      const theirs = (await (
        await handleAuthSession(bearerReq(await makeToken(validClaims({ sub: "firebase-uid-2" }))), env)
      ).json()) as any;
      expect(theirs.userId).not.toBe(mine.userId);

      expect(await revokeAllSessions(env, mine.userId)).toBe(1);

      expect(await resolveSession(bearerReq(mine.sessionToken), env)).toBeNull();
      expect(await resolveSession(bearerReq(theirs.sessionToken), env)).toEqual({ userId: theirs.userId });
    });

    it("is a no-op, not an error, for an account with nothing live", async () => {
      const env = makeEnv();
      expect(await revokeAllSessions(env, "AAAAH73X7P55T48R4CFHDED9CW")).toBe(0);
    });

    // ⚠️ The edge-cache purge is NOT covered here: node has no Cache API, so
    // `edgeCache()` returns null and that half is skipped entirely. It is the half that
    // decides whether a ban bites now or in up to SESSION_CACHE_MAX_TTL_S, and only a
    // real request against a deployed Worker can prove it.
  });

  // Without X-Revoke-Session a renewed token stayed valid for its full 90 days
  // with no device holding it, so nothing could revoke it and signing out did not
  // end it. Device-confirmed on 2026-07-26: 3 sessions, 1 revoked, 2 still live.
  describe("retiring the replaced session (X-Revoke-Session)", () => {
    const renewReq = async (old: string) =>
      new Request("https://flickto.app/api/auth/session", {
        method: "POST",
        headers: { Authorization: `Bearer ${await makeToken(validClaims())}`, "X-Revoke-Session": old },
      });

    it("revokes the old session so it stops resolving", async () => {
      const env = makeEnv();
      const first = (await (await handleAuthSession(bearerReq(await makeToken(validClaims())), env)).json()) as any;
      const second = (await (await handleAuthSession(await renewReq(first.sessionToken), env)).json()) as any;

      expect(await resolveSession(bearerReq(first.sessionToken), env)).toBeNull();
      expect(await resolveSession(bearerReq(second.sessionToken), env)).toEqual({ userId: second.userId });
      expect(env.DB.sessions.filter((s: any) => s.revoked_at == null).length).toBe(1);
    });

    it("leaves one live session after renew-then-logout", async () => {
      const env = makeEnv();
      const first = (await (await handleAuthSession(bearerReq(await makeToken(validClaims())), env)).json()) as any;
      const second = (await (await handleAuthSession(await renewReq(first.sessionToken), env)).json()) as any;
      await handleAuthLogout(bearerReq(second.sessionToken, "https://flickto.app/api/auth/logout"), env);

      // The whole point: no live session survives a sign-out.
      expect(env.DB.sessions.filter((s: any) => s.revoked_at == null).length).toBe(0);
    });

    it("cannot revoke another user's session", async () => {
      const env = makeEnv();
      const victim = (await (
        await handleAuthSession(bearerReq(await makeToken(validClaims({ sub: "firebase-uid-2" }))), env)
      ).json()) as any;
      // Attacker holds their own valid Firebase token and names the victim's session.
      await handleAuthSession(await renewReq(victim.sessionToken), env);

      expect(await resolveSession(bearerReq(victim.sessionToken), env)).toEqual({ userId: victim.userId });
    });

    it("ignores an unknown or blank outgoing token", async () => {
      const env = makeEnv();
      await handleAuthSession(bearerReq(await makeToken(validClaims())), env);
      expect((await handleAuthSession(await renewReq("never-issued"), env)).status).toBe(200);
      expect((await handleAuthSession(await renewReq("   "), env)).status).toBe(200);
    });

    it("purges the user's expired sessions on mint", async () => {
      const env = makeEnv();
      const live = (await (await handleAuthSession(bearerReq(await makeToken(validClaims())), env)).json()) as any;
      // Age the existing row out, then mint again.
      env.DB.sessions[0].expires_at = Date.now() - 1000;
      await handleAuthSession(bearerReq(await makeToken(validClaims())), env);

      expect(env.DB.sessions.length).toBe(1);
      expect(await resolveSession(bearerReq(live.sessionToken), env)).toBeNull();
    });
  });

  it("gives different uids different opaque user ids", async () => {
    const env = makeEnv();
    const a = (await (await handleAuthSession(bearerReq(await makeToken(validClaims())), env)).json()) as any;
    const b = (await (
      await handleAuthSession(bearerReq(await makeToken(validClaims({ sub: "firebase-uid-2" }))), env)
    ).json()) as any;
    expect(b.userId).not.toBe(a.userId);
    expect(env.DB.users.length).toBe(2);
  });

  it("rejects an expired session", async () => {
    const env = makeEnv();
    const body = (await (await handleAuthSession(bearerReq(await makeToken(validClaims())), env)).json()) as any;
    env.DB.sessions[0].expires_at = Date.now() - 1;
    expect(await resolveSession(bearerReq(body.sessionToken), env)).toBeNull();
  });

  it("rejects an unknown session token and a missing header", async () => {
    const env = makeEnv();
    expect(await resolveSession(bearerReq("garbage"), env)).toBeNull();
    expect(await resolveSession(new Request("https://flickto.app/x"), env)).toBeNull();
  });

  it("503s when FIREBASE_PROJECT_ID is unset", async () => {
    const res = await handleAuthSession(bearerReq(await makeToken(validClaims())), makeEnv({ FIREBASE_PROJECT_ID: undefined }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured" });
  });

  it("401s on a bad token", async () => {
    const res = await handleAuthSession(bearerReq("not-a-jwt"), makeEnv());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("403s a suspended user without minting a session", async () => {
    const env = makeEnv();
    const body = (await (await handleAuthSession(bearerReq(await makeToken(validClaims())), env)).json()) as any;
    env.DB.users[0].status = "suspended";
    const res = await handleAuthSession(bearerReq(await makeToken(validClaims())), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(env.DB.sessions.length).toBe(1);
    expect(body.userId).toBe(env.DB.users[0].id);
  });

  it("logout is idempotent: garbage token, no header and a re-logout all 204", async () => {
    const env = makeEnv();
    const logoutUrl = "https://flickto.app/api/auth/logout";
    expect((await handleAuthLogout(bearerReq("garbage-token", logoutUrl), env)).status).toBe(204);
    expect((await handleAuthLogout(new Request(logoutUrl, { method: "POST" }), env)).status).toBe(204);

    const body = (await (await handleAuthSession(bearerReq(await makeToken(validClaims())), env)).json()) as any;
    expect((await handleAuthLogout(bearerReq(body.sessionToken, logoutUrl), env)).status).toBe(204);
    expect((await handleAuthLogout(bearerReq(body.sessionToken, logoutUrl), env)).status).toBe(204);
  });
});

// ── Routing ──────────────────────────────────────────────────────────────────
describe("routing", () => {
  class StubBucket {
    async get() {
      return null;
    }
    async put() {}
    async head() {
      return null;
    }
    async delete() {}
    async list() {
      return { objects: [], delimitedPrefixes: [], truncated: false, cursor: undefined };
    }
  }
  const ctx = { waitUntil: () => {} } as any;

  it("routes POST /api/auth/session and POST /api/auth/logout", async () => {
    const env = makeEnv({ BUCKET: new StubBucket() });
    const res = await worker.fetch(bearerReq(await makeToken(validClaims())), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    const out = await worker.fetch(bearerReq(body.sessionToken, "https://flickto.app/api/auth/logout"), env, ctx);
    expect(out.status).toBe(204);
  });
});

// ── POST /api/auth/probe ─────────────────────────────────────────────────────
// The point of this endpoint is a NEGATIVE: it must answer the question without
// creating anything. Every test here asserts the row counts are unchanged, because a
// probe that quietly created the account would satisfy every other assertion.
describe("POST /api/auth/probe", () => {
  const probeEnv = () => ({ DB: new TestD1(), FIREBASE_PROJECT_ID: PROJECT_ID }) as any;
  const probeReq = (token: string) =>
    new Request("https://flickto.app/api/auth/probe", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

  const probe = async (env: any, claims: Record<string, unknown> = {}) => {
    const res = await handleAuthProbe(probeReq(await makeToken(validClaims(claims))), env);
    return { status: res.status, body: (await res.json()) as { exists?: boolean; hasName?: boolean } };
  };

  it("reports an unknown identity as not existing, and CREATES NOTHING", async () => {
    const env = probeEnv();

    const { status, body } = await probe(env);

    expect(status).toBe(200);
    expect(body).toEqual({ exists: false, hasName: false });
    // The whole reason the endpoint exists. If these ever become 1, the probe has
    // become the thing it was built to avoid.
    expect(env.DB.count("users")).toBe(0);
    expect(env.DB.count("identities")).toBe(0);
    expect(env.DB.count("sessions")).toBe(0);
  });

  it("reports an existing account WITHOUT a name — the case that repairs the 15", async () => {
    const env = probeEnv();
    // Mint the account the way production does, then probe the same uid.
    await handleAuthSession(bearerReq(await makeToken(validClaims())), env);
    expect(env.DB.count("users")).toBe(1);

    const { body } = await probe(env);

    expect(body).toEqual({ exists: true, hasName: false });
    expect(env.DB.count("users")).toBe(1); // still no second account
  });

  it("reports an existing account WITH a name, so a returning user is never re-asked", async () => {
    const env = probeEnv();
    const minted = await handleAuthSession(bearerReq(await makeToken(validClaims())), env);
    const { userId } = (await minted.json()) as { userId: string };
    await env.DB.prepare(
      "INSERT INTO profiles (user_id, display_name, updated_at) VALUES (?, ?, ?)",
    )
      .bind(userId, "Sam", Date.now())
      .run();

    expect((await probe(env)).body).toEqual({ exists: true, hasName: true });
  });

  it("treats an empty display name as no name, matching the client's isBlank test", async () => {
    const env = probeEnv();
    const minted = await handleAuthSession(bearerReq(await makeToken(validClaims())), env);
    const { userId } = (await minted.json()) as { userId: string };
    await env.DB.prepare("INSERT INTO profiles (user_id, display_name, updated_at) VALUES (?, '', ?)")
      .bind(userId, Date.now())
      .run();

    expect((await probe(env)).body).toEqual({ exists: true, hasName: false });
  });

  it("answers only for the presented identity — a different uid is a different answer", async () => {
    const env = probeEnv();
    await handleAuthSession(bearerReq(await makeToken(validClaims())), env);

    // Same signing key, different subject: this is the strongest statement the endpoint
    // makes. Knowing somebody's uid is not enough — you must hold THEIR token.
    expect((await probe(env, { sub: "firebase-uid-2" })).body).toEqual({ exists: false, hasName: false });
  });

  it("401s an unverifiable token and 503s with no project configured, creating nothing", async () => {
    const env = probeEnv();

    const bad = await handleAuthProbe(probeReq(await makeToken(validClaims(), { sign: false })), env);
    expect(bad.status).toBe(401);

    const unconfigured = await handleAuthProbe(
      probeReq(await makeToken(validClaims())),
      { DB: new TestD1() } as any,
    );
    expect(unconfigured.status).toBe(503);
    expect(env.DB.count("users")).toBe(0);
  });

  it("is reachable through the worker's router", async () => {
    const env = probeEnv();
    const res = await worker.fetch(probeReq(await makeToken(validClaims())), env, { waitUntil: () => {} } as any);
    // 404/405 here would mean the path never reached the handler — the failure mode this
    // codebase has hit twice, and which --dry-run and every unit test pass regardless.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: false, hasName: false });
  });
});
