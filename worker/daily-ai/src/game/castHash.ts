/**
 * One-way hash of a Trakt person id, for the shared-cast reveal.
 *
 * ## Why hashed and not plain
 *
 * The puzzle payload is public. Shipping "Sarah Michelle Gellar, Alyson Hannigan" in
 * plaintext would give the answer away to anyone who opened the URL far more directly
 * than the obfuscated title does — a cast list is a stronger fingerprint than the title
 * itself. Hashing lets a client test "is this person in the answer?" without being able to
 * read who any of them are.
 *
 * A client only ever learns about people it ALREADY fetched for its own guess, and only
 * that they also appear in the answer. That is exactly the reveal, and nothing more.
 *
 * ## FNV-1a, and why that is enough
 *
 * This is not a security boundary — Trakt person ids are a small enumerable space, so a
 * determined attacker could brute-force these exactly as they could dictionary-attack the
 * title. It buys the same thing the title obfuscation buys: opening the JSON tells you
 * nothing. Anything stronger would be theatre at a cost.
 *
 * ⚠️ MUST match `OneTakeCastHash` in
 * android/app/src/main/java/com/flickto/app/domain/game/OneTakeCast.kt, byte for byte. A
 * hash that disagrees does not error — it simply never matches, so the strip stays empty
 * forever and looks like a title with no shared cast.
 */
export function castHash(traktPersonId: number): string {
  let h = 0x811c9dc5;
  const text = String(traktPersonId);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
