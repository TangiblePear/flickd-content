export type CategoryKind = "MEDIA" | "PEOPLE";

export interface Template {
  templateId: string;
  displayName: string;
  slugPrefix: string;
  eventName: string;
  categories: { name: string; kind: CategoryKind }[];
}

export interface Nominee {
  tmdbId: number;
  title: string;
  type: string;
  posterUrl?: string | null;
  isWinner?: boolean;
  personName?: string | null;
}

export interface Category {
  name: string;
  kind: CategoryKind;
  nominees: Nominee[];
}

export interface AwardSeason {
  id: string;
  eventName: string;
  year: number;
  startDate: string;
  endDate: string;
  ceremonyDate?: string | null;
  categories: Category[];
}

export interface SeasonSummary {
  slug: string;
  eventName: string;
  year: number;
  ceremonyDate: string | null;
  startDate: string;
  endDate: string;
  nomineeCount: number;
  winnerCount: number;
  categoryCount: number;
}

export interface TmdbResult {
  tmdbId: number;
  title: string;
  type: "MOVIE" | "TV";
  year: string | null;
  posterUrl: string | null;
  overview: string;
}

export interface DraftNominee {
  title: string;
  personName?: string | null;
  tmdbId?: number | null;
  type?: "MOVIE" | "TV";
  year?: string | null;
  isWinner?: boolean;
}

export interface DraftCategory {
  name: string;
  kind: CategoryKind;
  nominees: DraftNominee[];
}

export interface DraftSeason {
  id: string;
  eventName: string;
  year: number;
  startDate: string;
  endDate: string;
  ceremonyDate?: string | null;
  categories: DraftCategory[];
}

export type ResolutionStatus = "confident" | "ambiguous" | "missing";

export interface ReviewQueueItem {
  title: string;
  // Every category this title appears in within the draft (deduped, in
  // source-encounter order). Drives the "appears in N categories" subtitle
  // on the review card.
  categoryNames: string[];
  status: ResolutionStatus;
  candidates: TmdbResult[];
  // Every (categoryIndex, nomineeIndex) slot in `season.categories` that
  // this title fills. A single curator pick applies to every reference so
  // shared titles (Best Picture + Best Director + Best Cinematography for
  // the same film) only prompt once.
  references: Array<{ categoryIndex: number; nomineeIndex: number }>;
}

export interface ResolveResult {
  season: AwardSeason;
  reviewQueue: ReviewQueueItem[];
  stats: { total: number; confident: number; ambiguous: number; missing: number };
}

