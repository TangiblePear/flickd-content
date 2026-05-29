import * as cheerio from "cheerio";

const urls = [
  "https://en.wikipedia.org/wiki/BET_Awards_2026",
  "https://en.wikipedia.org/wiki/78th_Primetime_Emmy_Awards",
  "https://en.wikipedia.org/wiki/96th_Academy_Awards",
];

for (const url of urls) {
  const r = await fetch(url, { headers: { "user-agent": "FlickdAdmin/1.0 (+local)" } });
  const html = await r.text();
  const $ = cheerio.load(html);
  console.log(`\n=== ${url} ===`);
  console.log("#mw-content-text:", $("#mw-content-text").length, " main:", $("main").length);
  console.log(".mw-parser-output:", $(".mw-parser-output").length);
  console.log("table.wikitable count:", $("table.wikitable").length);
  console.log("h2 count:", $("h2").length, " .mw-headline count:", $(".mw-headline").length);
  console.log("h1#firstHeading:", JSON.stringify($("h1#firstHeading").text().trim()));
  console.log("table.infobox count:", $("table.infobox").length);

  // sample first wikitable td structure
  const $content = $("#mw-content-text").length ? $("#mw-content-text") : $("main");
  const firstTbl = $content.find("table.wikitable").first();
  console.log("first wikitable tds:", firstTbl.find("td").length);
  const firstTd = firstTbl.find("td").first();
  console.log("first td > div:", firstTd.children("div").length, " > ul:", firstTd.children("ul").length);
  console.log("first td html (300):", firstTd.html()?.slice(0, 300));
}
