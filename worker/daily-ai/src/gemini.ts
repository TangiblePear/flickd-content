export interface GeminiTitle {
  title: string;
  year?: number;
  type: "movie" | "tv";
  reason: string;
}

const ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

export async function generateTitles(
  apiKey: string,
  instruction: string,
  targetCount: number,
): Promise<GeminiTitle[]> {
  const prompt = `${instruction}

Return strictly valid JSON of the form:
{
  "items": [
    { "title": "...", "year": 2024, "type": "movie" | "tv", "reason": "one short sentence" }
  ]
}

Return exactly ${targetCount} items. Do not include any prose outside the JSON.`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.7,
    },
  };

  const r = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${await r.text()}`);

  const data = (await r.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text) throw new Error("gemini returned empty body");

  const parsed = JSON.parse(text) as { items: GeminiTitle[] };
  if (!Array.isArray(parsed.items)) throw new Error("gemini response missing items array");
  return parsed.items;
}
