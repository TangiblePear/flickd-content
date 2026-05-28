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
}

export interface TmdbResult {
  tmdbId: number;
  title: string;
  type: "MOVIE" | "TV";
  year: string | null;
  posterUrl: string | null;
  overview: string;
}

