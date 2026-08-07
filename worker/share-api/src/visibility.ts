import { metaFor } from "./blockCatalog";

/**
 * Read-time visibility.
 *
 * `authz.ts` states the rule that ONE place decides who may read a profile.
 * This is the other half of it: what they read. It must stay the only such
 * place — a second filter somewhere else is the one nobody re-reads when the
 * rules change, and it fails OPEN.
 *
 * Filtering used to happen on the device at publish, into `friend_layout` and
 * `public_layout`. Three copies of one truth drifted three separate ways
 * (2026-08-07): the web edited only the canonical one, the consent that gated
 * the copies lived in a single client, and `public_stats` ended up richer than
 * `stats`. Deriving on read removes the class of bug rather than the instances.
 */

export interface Consents {
  friendSensitive: boolean;
  publicSensitive: boolean;
}

export type Audience = "owner" | "friend" | "public";

/**
 * The stored layout, reduced to what [audience] may see.
 *
 * A FILTER, never a rebuild: the owner's order is the whole reason a public
 * profile looks like the profile its owner arranged.
 */
export function visibleLayout(layout: unknown[], audience: Audience, c: Consents): unknown[] {
  if (audience === "owner") return layout;
  // Each audience reads ITS OWN consent. They are separate settings on the
  // device, and letting one stand in for the other takes blocks away from the
  // owner's friends whenever public activity happens to be off.
  const consented = audience === "friend" ? c.friendSensitive : c.publicSensitive;
  return layout.filter((raw) => {
    const type = (raw as { type?: unknown } | null)?.type;
    // A row with no usable type cannot be looked up, so it cannot be shown to
    // be safe — and anything not shown to be safe is withheld.
    if (typeof type !== "string") return false;
    const m = metaFor(type);
    if (!m.friendVisible || m.ownerOnly) return false;
    return audience === "friend" ? consented || !m.sensitive : m.publicVisible || consented;
  });
}

/**
 * Per-title keys, withheld unless the matching consent was given.
 *
 * The boundary belongs here rather than in the viewer's renderer: a client that
 * RECEIVES `recentWatches` has it, whether or not its layout draws it.
 */
const SENSITIVE_KEYS = ["topRated", "recentWatches", "currentlyWatching"] as const;

export function visibleStats(
  stats: Record<string, unknown> | null,
  audience: Audience,
  c: Consents,
): Record<string, unknown> | null {
  if (stats == null || audience === "owner") return stats;
  const consented = audience === "friend" ? c.friendSensitive : c.publicSensitive;
  if (consented) return stats;
  // Copied, not edited: the caller's blob may be reused for another audience in
  // the same request.
  const out = { ...stats };
  for (const k of SENSITIVE_KEYS) delete out[k];
  return out;
}
