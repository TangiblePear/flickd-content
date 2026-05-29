import { isWikipediaUrl, parseWikipediaCeremony } from "./admin/server/import/wikipedia.mjs";

const urls = [
  "https://en.wikipedia.org/wiki/BET_Awards_2026",
  "https://en.wikipedia.org/wiki/78th_Primetime_Emmy_Awards",
  "https://en.wikipedia.org/wiki/96th_Academy_Awards", // known-good control
];

for (const url of urls) {
  try {
    const r = await fetch(url, { headers: { "user-agent": "FlickdAdmin/1.0 (+local)" } });
    const html = await r.text();
    console.log(`\n=== ${url} ===`);
    console.log("http status:", r.status, "bytes:", html.length, "isWiki:", isWikipediaUrl(url));
    const draft = parseWikipediaCeremony(html, url, {});
    if (!draft) {
      console.log("parseWikipediaCeremony => NULL (parser bailed)");
    } else {
      console.log("draft id:", draft.id, "year:", draft.year, "event:", draft.eventName);
      console.log("categories:", draft.categories.length);
      for (const c of draft.categories) console.log("  -", c.kind, c.name, "(", c.nominees.length, "nominees )");
    }
  } catch (e) {
    console.log(`ERROR for ${url}:`, e.message);
  }
}
