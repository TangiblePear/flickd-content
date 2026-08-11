/**
 * Title obfuscation for the published puzzle.
 *
 * ## This is obfuscation, NOT encryption. Say so wherever it is used.
 *
 * The client grades offline, so the answer has to be in the file it downloads. All this
 * does is stop `content/game/latest.json` spoiling the puzzle for someone who pastes the
 * URL into a browser: they see base64, and decoding that yields more noise. The key ships
 * inside every client, because the client is what decodes the title in order to grade a
 * guess. Anyone reading the web bundle or decompiling the APK has it.
 *
 * That bar is higher than "anyone can read it" and lower than "safe". The failure mode is
 * not one person cracking it, it is one person PUBLISHING the key, after which the bar is
 * zero for everybody.
 *
 * ## Which is why KEY_VERSION exists
 *
 * Rotation is the response to a published key: change KEY below, bump KEY_VERSION, and
 * every new deploy and app release invalidates the post. The version travels in the
 * payload so clients can keep decoding the old key for a release or two rather than
 * needing a flag day — Android users update on their own schedule, and a rotation that
 * breaks every un-updated phone is a rotation nobody will ever actually perform.
 *
 * ## Do not "upgrade" this to a hash
 *
 * Shipping sha256(title) and hashing each guess looks like it closes the hole and does
 * not. The client already holds the entire guess universe — all ~31k titles, for
 * autocomplete — so an attacker hashes all of them and looks for the match, in
 * milliseconds. Any scheme where the client can grade offline is dictionary-attackable.
 * Server-validated guessing is the only real fix, and it is deliberately out of scope.
 */

/** Bump alongside KEY. Travels in the payload as `keyVersion`. */
export const KEY_VERSION = 1;

/** Rotate this, and KEY_VERSION, if the key is ever published somewhere. */
const KEY = "flickto-one-take-2026";

const KEY_BYTES = new TextEncoder().encode(KEY);

/**
 * UTF-8 -> XOR with the repeating key -> base64.
 *
 * Goes through bytes rather than characters so non-ASCII titles survive intact; the
 * catalogue is full of them and a mangled answer would fail to match a correct guess.
 */
export function obfuscateTitle(title: string): string {
  const bytes = new TextEncoder().encode(title);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i] ^ KEY_BYTES[i % KEY_BYTES.length];
  }
  let binary = "";
  for (const b of out) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Present so the worker's own tests can prove a round trip; clients have their own. */
export function deobfuscateTitle(encoded: string): string {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i) ^ KEY_BYTES[i % KEY_BYTES.length];
  }
  return new TextDecoder().decode(bytes);
}
