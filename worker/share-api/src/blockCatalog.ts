// Server-side mirror of
// android/app/src/main/java/com/flickto/app/domain/profile/ProfileBlockCatalog.kt.
//
// The Kotlin file is AUTHORITATIVE — it is the map that has been publishing
// profiles — and this exists because read-time filtering cannot ask a client
// what a block means. A client-declared visibility would be a privacy decision
// taken on the word of the thing being filtered.
//
// When a block type is added there, add it here. Until then the owner-only
// default keeps it off every foreign profile, which is the safe direction to be
// wrong in: a new block is invisible to friends for one server release, rather
// than public for one.

export interface BlockMeta {
  /** May leave the device at all. */
  friendVisible: boolean;
  ownerOnly: boolean;
  /** Safe for strangers: identity and curation rather than behaviour. */
  publicVisible: boolean;
  /** Exposes per-title behaviour; gated on the FRIENDS path by its own consent. */
  sensitive: boolean;
}

/** Every mapped type is friend-visible and not owner-only; only the last two vary. */
const F = (publicVisible = false, sensitive = false): BlockMeta => ({
  friendVisible: true,
  ownerOnly: false,
  publicVisible,
  sensitive,
});

// `publicVisible` marks the curated half — identity and choices. The
// behavioural half is withheld from strangers unless public activity is on.
// WRAPPED counts as behavioural: it renders the mosaic numbers and genre names,
// so publishing it would leak by the back door exactly what withholding
// STAT_MOSAIC and GENRE_DNA is for.
const META: Record<string, BlockMeta> = {
  stat_mosaic: F(),
  achievement_showcase: F(true),
  fav_movies: F(true),
  fav_shows: F(true),
  fav_people: F(true),
  personality: F(true),
  genre_dna: F(),
  currently_watching: F(false, true),
  top_rated: F(false, true),
  recent_activity: F(false, true),
  wrapped: F(),
  bio: F(true),
  taste_tags: F(true),
  streak: F(),
  // Curation, not behaviour: lists the owner built and then picked, one by one, to put on
  // display. Same reasoning as fav_movies, and it must match ProfileBlockCatalog.kt —
  // this is the entry that decides whether `sharedLists` is materialised for a reader.
  lists: F(true),
};

const OWNER_ONLY: BlockMeta = {
  friendVisible: false,
  ownerOnly: true,
  publicVisible: false,
  sensitive: false,
};

/** Metadata for [type], defaulting to owner-only for anything unmapped. */
export function metaFor(type: string): BlockMeta {
  return META[type] ?? OWNER_ONLY;
}
