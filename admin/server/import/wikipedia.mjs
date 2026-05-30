import * as cheerio from "cheerio";
import { isExcludedCategory } from "./filters.mjs";

const PEOPLE_KEYWORDS = [
  "actor",
  "actress",
  "director",
  "directing",
  "performance",
  "host",
  "supporting",
  "lead",
];

const kindFor = (name) => {
  const n = name.toLowerCase();
  return PEOPLE_KEYWORDS.some((k) => n.includes(k)) ? "PEOPLE" : "MEDIA";
};

// Strips Wikipedia bracket annotations: citation refs ("[1]", "[a]"),
// inter-language link markers ("[de; es]"), edit markers, etc. Anything
// inside `[...]` is editorial metadata, never part of a real title.
const cleanText = (s) =>
  String(s ?? "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const stripWinnerMarks = (s) => cleanText(String(s ?? "").replace(/[‡†*]+/g, " "));

function isWikipediaHost(url) {
  try {
    const u = new URL(url);
    return u.hostname === "en.wikipedia.org";
  } catch {
    return false;
  }
}

// Returns the text of a <li> excluding any nested <ul>/<ol> (which are
// runner-up nominees, not part of this row's own line).
function lineTextWithoutNested($li) {
  const $clone = $li.clone();
  $clone.find("ul, ol").remove();
  return cleanText($clone.text());
}

function firstItalicTitle($li) {
  const $clone = $li.clone();
  $clone.find("ul, ol").remove();
  const t = cleanText($clone.find("i").first().text());
  return t || null;
}

// Winners are marked on Wikipedia by a `<b>` wrap around the row text and/or
// a "‡"/"†" glyph appended to the line. We sample the cell-level row only
// (nested <ul> children are runner-ups, not winners). The bold may be nested
// inside the italic title (e.g. picture categories: `<i><b><a>Film</a></b></i>`)
// so we search descendants, not just direct children — the nested nominee
// <ul>/<ol> have already been stripped, so any remaining <b> is the winner's.
function detectWinner($li) {
  const $clone = $li.clone();
  $clone.find("ul, ol").remove();
  const text = $clone.text();
  if (text.includes("‡") || text.includes("†")) return true;
  return $clone.find("b").length > 0;
}

// Build a nominee from one row of text using the <i> tag as the film/show
// title indicator.
//   MEDIA rows:  "<i>Film</i> – producers"
//   PEOPLE rows: "<a>Person</a> – <i>Film</i> as Role"
//
// PEOPLE rows REQUIRE an associated film/show. Rows that are just names
// (e.g. BAFTA Rising Star, Outstanding Contribution awards) return null so
// the category-level filmCount check can drop the whole category.
function buildNominee($li, kind) {
  const rawLine = lineTextWithoutNested($li);
  const isWinner = detectWinner($li);
  const line = stripWinnerMarks(rawLine);
  if (!line) return null;

  const film = firstItalicTitle($li);

  if (kind === "PEOPLE") {
    const split = line.split(/\s[–—-]\s/);
    const personName = cleanText(split[0]);
    if (!personName) return null;

    let title = film;
    if (!title && split.length > 1) {
      const candidate = cleanText(split[1]);
      // Reject candidates that are just the person's name echoed back, or
      // role/bio text like "for outstanding work", "as Various". Require
      // an actual film/show reference.
      if (candidate && candidate.toLowerCase() !== personName.toLowerCase()) {
        title = candidate;
      }
    }
    if (!title) return null;

    return isWinner ? { title, personName, isWinner: true } : { title, personName };
  }

  // MEDIA — italicised title preferred, fall back to first text segment.
  const title = film || cleanText(line.split(/\s[–—-]\s/)[0]);
  if (!title) return null;
  return isWinner ? { title, isWinner: true } : { title };
}

// Primary parser for the modern Wikipedia ceremony layout: one big
// `table.wikitable` whose every <td> cell is a category. The cell contains
// a heading <div> followed by a <ul> with one top-level <li> (the winner)
// containing a nested <ul> of the other nominees.
function parseAwardCells($, $content) {
  const categories = [];

  $content.find("table.wikitable").each((_, tbl) => {
    $(tbl)
      .find("td")
      .each((_, td) => {
        const $td = $(td);
        const $div = $td.children("div").first();
        const $ul = $td.children("ul").first();
        if (!$div.length || !$ul.length) return;

        const name = cleanText($div.text());
        if (!name || isExcludedCategory(name)) return;

        const kind = kindFor(name);
        const nominees = [];
        let filmCount = 0;

        $ul.children("li").each((_, li) => {
          const $li = $(li);
          if (firstItalicTitle($li)) filmCount += 1;
          const winner = buildNominee($li, kind);
          if (winner) nominees.push(winner);

          $li
            .children("ul, ol")
            .children("li")
            .each((_, sub) => {
              const $sub = $(sub);
              if (firstItalicTitle($sub)) filmCount += 1;
              const n = buildNominee($sub, kind);
              if (n) nominees.push(n);
            });
        });

        // Drop categories whose rows have NO film/show reference at all
        // (e.g. BAFTA Rising Star Award, lifetime/contribution awards).
        // Such awards honor a person without a specific work attached and
        // don't belong in a film/show-keyed catalog.
        if (nominees.length === 0 || filmCount === 0) return;
        categories.push({ name, kind, nominees });
      });
  });

  return categories;
}

// Fallback for older ceremony pages where each category lives under its own
// heading and nominees are in simple <ul>s.
function parseHeadingsLayout($, $content) {
  const categories = [];
  let current = null;

  $content.find("h2, h3, h4, table.wikitable, ul").each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    if (tag === "h2" || tag === "h3" || tag === "h4") {
      const headline =
        $(el).find(".mw-headline").first().text() || $(el).text();
      const name = cleanText(headline);
      if (isExcludedCategory(name)) {
        current = null;
        return;
      }
      current = { name, kind: kindFor(name), nominees: [], filmCount: 0 };
      categories.push(current);
      return;
    }

    if (!current) return;

    if (tag === "table") {
      $(el)
        .find("tr")
        .each((_, tr) => {
          $(tr)
            .find("td")
            .each((_, td) => {
              $(td)
                .find("li")
                .each((_, line) => {
                  const $line = $(line);
                  if (firstItalicTitle($line)) current.filmCount += 1;
                  const n = buildNominee($line, current.kind);
                  if (n) current.nominees.push(n);
                });
            });
        });
      return;
    }

    if (tag === "ul") {
      $(el)
        .children("li")
        .each((_, li) => {
          const $li = $(li);
          if (firstItalicTitle($li)) current.filmCount += 1;
          const n = buildNominee($li, current.kind);
          if (n) current.nominees.push(n);
        });
    }
  });

  // Drop categories with no film/show reference anywhere (same rule as
  // parseAwardCells — see comment there).
  return categories
    .filter((c) => c.nominees.length > 0 && c.filmCount > 0)
    .map(({ filmCount, ...rest }) => rest);
}

function dedupe(nominees) {
  const seen = new Set();
  return nominees.filter((n) => {
    const key = `${n.title}::${n.personName ?? ""}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Parses an English Wikipedia date like "March 15, 2026" or "15 March 2026"
// into YYYY-MM-DD. Returns null if no recognizable date is found.
function parseInfoboxDate(text) {
  if (!text) return null;

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const monthFirst = text.match(/\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (monthFirst) {
    const mo = MONTHS[monthFirst[1].toLowerCase()];
    if (mo) {
      return `${monthFirst[3]}-${String(mo).padStart(2, "0")}-${String(Number(monthFirst[2])).padStart(2, "0")}`;
    }
  }

  const dayFirst = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})\b/);
  if (dayFirst) {
    const mo = MONTHS[dayFirst[2].toLowerCase()];
    if (mo) {
      return `${dayFirst[3]}-${String(mo).padStart(2, "0")}-${String(Number(dayFirst[1])).padStart(2, "0")}`;
    }
  }

  return null;
}

// Reads the ceremony date out of the page's infobox. Prefers the
// `<span class="bday">` microformat (machine-readable), falls back to
// parsing the "Date" row's visible text.
function extractInfoboxDate($) {
  const ibox = $("table.infobox").first();
  if (!ibox.length) return null;

  const bday = ibox.find(".bday").first().text().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(bday)) return bday;

  let dateText = null;
  ibox.find("tr").each((_, tr) => {
    const header = cleanText($(tr).find("th").first().text()).toLowerCase();
    if (header === "date" || header === "date(s)" || header === "ceremony date") {
      dateText = cleanText($(tr).find("td").first().text());
      return false;
    }
  });
  return parseInfoboxDate(dateText);
}

// Reads the nominations-announced date. Tries an infobox row labeled
// "Announced" / "Nominations announced" first, then falls back to scanning
// the article intro for a phrase like "nominees ... were announced on …".
function extractAnnouncedDate($, $content) {
  const ibox = $("table.infobox").first();
  if (ibox.length) {
    let dateText = null;
    ibox.find("tr").each((_, tr) => {
      const header = cleanText($(tr).find("th").first().text()).toLowerCase();
      if (
        header === "announced" ||
        header === "nominations announced" ||
        header === "nominations"
      ) {
        dateText = cleanText($(tr).find("td").first().text());
        return false;
      }
    });
    const fromBox = parseInfoboxDate(dateText);
    if (fromBox) return fromBox;
  }

  // Intro paragraphs — usually within the first 4 <p>s.
  const paragraphs = $content.find("p").slice(0, 6);
  let combined = "";
  paragraphs.each((_, p) => {
    combined += " " + cleanText($(p).text());
  });

  const monthFirst =
    /(?:nominee|nomination)[a-z]*\b[^.]*?\bannounc[a-z]+\b[^.]*?\b([A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/.exec(
      combined,
    );
  if (monthFirst) {
    const d = parseInfoboxDate(monthFirst[1]);
    if (d) return d;
  }
  const dayFirst =
    /(?:nominee|nomination)[a-z]*\b[^.]*?\bannounc[a-z]+\b[^.]*?\b(\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+\s+\d{4})\b/.exec(
      combined,
    );
  if (dayFirst) {
    const d = parseInfoboxDate(dayFirst[1]);
    if (d) return d;
  }

  return null;
}

function addDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function inferSeasonMeta(html) {
  const $ = cheerio.load(html);
  const title = cleanText($("h1#firstHeading").text() || $("title").text());

  let year = null;
  const yearMatch = title.match(/(\d{4})/);
  if (yearMatch) {
    year = Number(yearMatch[1]);
  } else {
    // Ordinal-numbered ceremonies (e.g. "98th Academy Awards") have no year
    // in the title. Pull it from the infobox or intro paragraph instead.
    const infoboxText = cleanText($("table.infobox").first().text());
    const introText = cleanText($("#mw-content-text p").first().text());
    const fromBody = (infoboxText + " " + introText).match(/\b(19|20)\d{2}\b/);
    if (fromBody) year = Number(fromBody[0]);
  }

  let eventName = title;
  eventName = eventName
    .replace(/^list of nominees for the\s*/i, "")
    .replace(/^(the\s+)?\d+(st|nd|rd|th)\s+/i, "")
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .replace(/\s*\d{4}\s*$/, "")
    .trim();

  return { title, year, eventName };
}

export function isWikipediaUrl(url) {
  return isWikipediaHost(url);
}

export function parseWikipediaCeremony(html, url, hints = {}) {
  const $ = cheerio.load(html);
  const $content = $("#mw-content-text").length
    ? $("#mw-content-text")
    : $("main");
  if (!$content.length) return null;

  const meta = inferSeasonMeta(html);

  let categories = parseAwardCells($, $content);
  if (categories.length < 2) {
    categories = parseHeadingsLayout($, $content);
  }

  categories = categories
    .map((c) => ({ ...c, nominees: dedupe(c.nominees) }))
    .filter((c) => c.nominees.length > 0 && !isExcludedCategory(c.name));

  if (categories.length < 2) return null;

  const year = hints.year ?? meta.year;
  const eventName = hints.eventName ?? meta.eventName;
  const slugPrefix = hints.slugPrefix ?? slugify(eventName);
  if (!year || !eventName || !slugPrefix) return null;

  const ceremonyDate = extractInfoboxDate($);
  const announcedDate = extractAnnouncedDate($, $content);

  const startDate = announcedDate ?? `${year}-01-01`;
  const endDate = ceremonyDate ? addDays(ceremonyDate, 30) : `${year}-12-31`;

  return {
    id: `${slugPrefix}-${year}`,
    eventName,
    year,
    startDate,
    endDate,
    ceremonyDate,
    categories,
  };
}

function slugify(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
