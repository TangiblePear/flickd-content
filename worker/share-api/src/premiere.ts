// ── FlickTo Premiere: server-owned entitlement ───────────────────────────────
//
// The badge next to a name is a claim about a person that OTHER people read, so
// it must not be something a client can assert. `profiles` is a client-declared
// merge (`mergeValidated`) — it validates shapes, not truth — so the flag lives on
// `users.premiere_until`, which no request body can reach, and is written here and
// nowhere else.
//
// The client sends the Play purchase token it already holds; this worker checks it
// against the Play Developer API itself and stores the expiry Google reports.
//
// See migration 0028.

import { getGoogleAccessToken } from "./fcm";
import { resolveSession } from "./auth";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

export interface PremiereEnv {
  DB: D1Database;
  /**
   * Play Developer API service account. All three are SECRETS:
   *   wrangler secret put PLAY_SA_CLIENT_EMAIL
   *   wrangler secret put PLAY_SA_PRIVATE_KEY     (the PEM, newlines or \n both fine)
   *   wrangler secret put PLAY_PACKAGE_NAME
   * Unset ⇒ the verify route 503s and nobody's stored entitlement changes. That is
   * the correct degraded state: no badges get granted, and none get revoked either.
   */
  PLAY_SA_CLIENT_EMAIL?: string;
  PLAY_SA_PRIVATE_KEY?: string;
  PLAY_PACKAGE_NAME?: string;
}

/**
 * The row shape every read path needs. Kept here so the meaning of the number lives in
 * one place.
 *
 * Optional because it arrives via LEFT JOIN: a row whose `users` parent is missing —
 * an orphaned profile, of which this deployment has a reaper — yields `undefined`, and
 * that has to mean "no badge", not a type error at the call site.
 */
export interface PremiereRow {
  premiere_until?: number | null;
}

/**
 * Whether a row is entitled right now.
 *
 * `premiere_until` is an expiry, not a boolean, so it expires itself — there is no
 * cron to forget to run and no state to reconcile. Every read path must go through
 * this rather than testing the column directly, or "expired" and "never subscribed"
 * will drift apart somewhere.
 */
export function isPremiere(row: PremiereRow | null | undefined, now = Date.now()): boolean {
  return (row?.premiere_until ?? 0) > now;
}

/**
 * The picture URL a reader should actually receive.
 *
 * An animated avatar is a Premiere feature, so it stops being served when the
 * subscription ends — otherwise one paid month buys a permanent GIF and the feature is a
 * one-off purchase wearing a subscription's clothes.
 *
 * Empty rather than deleted: the bytes stay in R2, so resubscribing restores the avatar
 * with no action from the user and a billing hiccup cannot destroy something they made.
 * Clients already treat an empty `pictureUrl` as "fall back to the pack avatar", which is
 * exactly the intended result.
 *
 * Costs nothing — every caller already joins `users` for [isPremiere].
 */
export function visiblePictureUrl(
  pictureUrl: string | null | undefined,
  row: (PremiereRow & { picture_animated?: number | null }) | null | undefined,
  now = Date.now(),
): string {
  const url = pictureUrl ?? "";
  if (!url) return "";
  const animated = (row?.picture_animated ?? 0) !== 0;
  return animated && !isPremiere(row, now) ? "" : url;
}

/**
 * The border id a reader should receive.
 *
 * Same rule as [visiblePictureUrl], for the cosmetic equivalent: a Premiere border is
 * rented, not earned, so it stops being shown when the subscription ends.
 *
 * ⚠️ Matched by PREFIX because the worker cannot know the client's cosmetic catalog.
 * `bd_pre_` is therefore a contract, not a naming convention — see `CosmeticCatalog`
 * on the Android side, which documents the same thing from the other end.
 *
 * The stored value is left alone; only the published one is withheld. The user's
 * selection survives a lapse and returns on resubscribe.
 */
export function visibleBorderId(
  borderId: string | null | undefined,
  row: PremiereRow | null | undefined,
  now = Date.now(),
): string {
  const id = borderId ?? "";
  if (!id.startsWith("bd_pre_")) return id;
  return isPremiere(row, now) ? id : "";
}

/**
 * The header colour a reader should receive.
 *
 * A DUOTONE — two hexes comma-separated, `"#RRGGBB,#RRGGBB"` — is the Premiere form; a
 * single colour is free and passes through untouched. Same rule as [visibleBorderId]:
 * rented, not earned, so it stops being published when the subscription ends.
 *
 * ⚠️ Degrades to the FIRST stop rather than to empty. Emptying would drop the person's
 * header back to the genre Flare gradient, which reads as "they changed their profile"
 * rather than "they stopped paying"; keeping the first colour is the honest degrade, and
 * the stored pair is untouched so resubscribing restores the gradient.
 *
 * The comma encoding lives in the existing `header_color` text column deliberately —
 * `mergeValidated` stores it as free text, so no migration was needed.
 */
export function visibleHeaderColor(
  headerColor: string | null | undefined,
  row: PremiereRow | null | undefined,
  now = Date.now(),
): string {
  const spec = (headerColor ?? "").trim();
  if (!spec.includes(",")) return spec;
  return isPremiere(row, now) ? spec : spec.split(",")[0].trim();
}

/** The Play states that mean "this person has paid and should be treated as such". */
const ENTITLED_STATES = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  // Cancelled but not yet lapsed: they keep what they bought until the term ends.
  "SUBSCRIPTION_STATE_CANCELED",
]);

interface SubscriptionPurchaseV2 {
  subscriptionState?: string;
  lineItems?: Array<{ expiryTime?: string }>;
}

/**
 * POST /api/me/premiere/verify — body `{ purchaseToken }`.
 *
 * Checks the token against Play and stores the expiry Google reports.
 *
 * **Failure handling is the whole design here.** There are two ways this can not
 * produce an entitlement, and they must not be conflated:
 *
 *  - Google answered, and the answer is "expired / refunded / unknown token". That
 *    is a real result and is written, including when it revokes.
 *  - Google could not be reached, or returned 5xx, or the credentials are missing.
 *    Nothing is written. A network blip must never revoke a paying subscriber's
 *    badge, and the client will simply try again on its next reconcile.
 */
export async function handleVerifyPremiere(
  req: Request,
  env: PremiereEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  if (!env.PLAY_SA_CLIENT_EMAIL || !env.PLAY_SA_PRIVATE_KEY || !env.PLAY_PACKAGE_NAME) {
    return json({ error: "not_configured" }, 503);
  }

  let body: { purchaseToken?: unknown };
  try {
    body = (await req.json()) as { purchaseToken?: unknown };
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const purchaseToken = typeof body.purchaseToken === "string" ? body.purchaseToken.trim() : "";
  // Play tokens are long opaque strings. A length bound is not validation, just a
  // cheap guard against a client sending something absurd straight into a URL.
  if (!purchaseToken || purchaseToken.length > 4096) {
    return json({ error: "invalid_token" }, 400);
  }

  const accessToken = await getGoogleAccessToken(
    {
      projectId: "",
      clientEmail: env.PLAY_SA_CLIENT_EMAIL,
      privateKey: env.PLAY_SA_PRIVATE_KEY,
    },
    "https://www.googleapis.com/auth/androidpublisher",
  );
  // Could not authenticate to Google at all — transient as far as this user is
  // concerned. Write nothing.
  if (!accessToken) return json({ error: "upstream_unavailable" }, 502);

  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(env.PLAY_PACKAGE_NAME)}/purchases/subscriptionsv2/tokens/` +
    `${encodeURIComponent(purchaseToken)}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (e) {
    console.error("premiere: play fetch threw", e);
    return json({ error: "upstream_unavailable" }, 502);
  }

  // 5xx is Google having a bad day; 401/403 means our credentials are wrong. Neither
  // is evidence about this user, so neither may change what we have stored.
  if (res.status >= 500 || res.status === 401 || res.status === 403) {
    console.error("premiere: play verify unusable", res.status, await res.text().catch(() => ""));
    return json({ error: "upstream_unavailable" }, 502);
  }

  // 404 IS an answer: Play does not know this token. Treat it as not entitled and
  // let it be written, so a token that has been refunded away stops granting a badge.
  let expiryMillis = 0;
  if (res.ok) {
    const purchase = (await res.json().catch(() => null)) as SubscriptionPurchaseV2 | null;
    const state = purchase?.subscriptionState ?? "";
    if (purchase && ENTITLED_STATES.has(state)) {
      // A subscription can carry several line items; the entitlement lasts as long as
      // the longest of them.
      for (const item of purchase.lineItems ?? []) {
        const t = item.expiryTime ? Date.parse(item.expiryTime) : NaN;
        if (Number.isFinite(t) && t > expiryMillis) expiryMillis = t;
      }
    }
  } else if (res.status !== 404) {
    // Some other 4xx we did not anticipate — do not guess what it means.
    console.error("premiere: play verify unexpected", res.status, await res.text().catch(() => ""));
    return json({ error: "upstream_unavailable" }, 502);
  }

  const now = Date.now();
  await env.DB
    .prepare(
      `UPDATE users
          SET premiere_until = ?,
              premiere_since = CASE WHEN premiere_since = 0 AND ? > ? THEN ? ELSE premiere_since END
        WHERE id = ?`,
    )
    // `premiere_since` is stamped only on a verification that actually grants, and only
    // the first time. It is unrecoverable after the fact — once a subscription lapses
    // there is no way to learn when it began — so it must never be overwritten.
    .bind(expiryMillis, expiryMillis, now, now, session.userId)
    .run();

  return json({ isPremiere: expiryMillis > now, premiereUntil: expiryMillis });
}
