export interface Prompt {
  id: string;
  theme: string;
  instruction: string;
}

// Indexed by day-of-week (Sunday=0). Easy to expand later.
export const PROMPT_ROTATION: Prompt[] = [
  {
    id: "critics-picks",
    theme: "Critics' picks of the week",
    instruction:
      "Recommend 10 critically-acclaimed but lesser-watched films or limited series from the last 5 years. Mix genres. Prefer titles rated 7.5+ on review aggregators but with under 200k votes.",
  },
  {
    id: "mood-board",
    theme: "Mood: comfort & cozy",
    instruction:
      "Recommend 10 films or shows that feel like a warm hug — gentle pacing, soft humour, low stakes. Mix decades. No horror, no heavy drama.",
  },
  {
    id: "decade-pairing",
    theme: "Then-and-now double features",
    instruction:
      "Recommend 10 films or shows organised as 5 pairs: one classic (pre-1990) and one modern (post-2015) that share a theme, director's influence, or remake lineage. Output as a flat list of 10 individual titles.",
  },
  {
    id: "hidden-gems",
    theme: "Hidden sci-fi & fantasy gems",
    instruction:
      "Recommend 10 sci-fi or fantasy films/series that are widely overlooked. Mix international and English-language. Skip blockbusters and franchises.",
  },
  {
    id: "director-spotlight",
    theme: "Director spotlight — overlooked auteurs",
    instruction:
      "Pick one acclaimed director who is underrated in the mainstream and recommend their 10 most essential films, ordered roughly by accessibility for a newcomer.",
  },
  {
    id: "double-feature",
    theme: "Weekend double-features",
    instruction:
      "Recommend 10 films suitable for back-to-back weekend viewing, mixing genres. Each should be under 130 minutes. Include both a punchy lead and a thematic complement.",
  },
  {
    id: "comfort-rewatches",
    theme: "Most-rewatchable shows",
    instruction:
      "Recommend 10 TV series with high rewatch value — strong episode-of-the-week structure, comfort casts, no homework required.",
  },
];

export function pickPromptFor(date: Date): Prompt {
  return PROMPT_ROTATION[date.getUTCDay()];
}
