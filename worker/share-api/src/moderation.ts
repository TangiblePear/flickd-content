// Image moderation for profile-picture uploads.
//
// Uses Google Cloud Vision SafeSearch (same cloud as Firebase/Gemini). A picture
// is rejected when adult / violence / racy comes back LIKELY or VERY_LIKELY.
// When moderation is disabled or no key is configured (dev), everything is
// allowed so the endpoint still works without the paid call.
//
// SafeSearch is an NSFW/violence classifier, NOT a PhotoDNA/NCMEC hash match —
// the CSAM safety net is Cloudflare's CSAM Scanning Tool on the zone plus the
// report → takedown flow.

interface ModerationEnv {
  MODERATION_ENABLED?: string;
  VISION_API_KEY?: string;
}

export interface ModerationResult {
  allowed: boolean;
  /** Short machine verdict stored on the picture meta: "clean" | "flagged" | "skipped". */
  verdict: string;
  /** Categories that tripped the block, e.g. ["adult", "racy"]. */
  categories: string[];
}

const REJECT_LIKELIHOODS = new Set(["LIKELY", "VERY_LIKELY"]);
const SCANNED_CATEGORIES = ["adult", "violence", "racy"] as const;

export async function moderateImage(bytes: Uint8Array, env: ModerationEnv): Promise<ModerationResult> {
  if (env.MODERATION_ENABLED !== "true" || !env.VISION_API_KEY) {
    return { allowed: true, verdict: "skipped", categories: [] };
  }

  const endpoint = `https://vision.googleapis.com/v1/images:annotate?key=${env.VISION_API_KEY}`;
  const payload = {
    requests: [
      {
        image: { content: base64(bytes) },
        features: [{ type: "SAFE_SEARCH_DETECTION" }],
      },
    ],
  };

  let annotation: Record<string, string> | undefined;
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      // Fail closed: if the scanner is unreachable, reject rather than let an
      // unscanned image through.
      return { allowed: false, verdict: "scan_error", categories: [] };
    }
    const data = (await resp.json()) as {
      responses?: Array<{ safeSearchAnnotation?: Record<string, string> }>;
    };
    annotation = data.responses?.[0]?.safeSearchAnnotation;
  } catch {
    return { allowed: false, verdict: "scan_error", categories: [] };
  }

  if (!annotation) return { allowed: false, verdict: "scan_error", categories: [] };

  const categories = SCANNED_CATEGORIES.filter((c) => REJECT_LIKELIHOODS.has(annotation![c]));
  return categories.length > 0
    ? { allowed: false, verdict: "flagged", categories: [...categories] }
    : { allowed: true, verdict: "clean", categories: [] };
}

/** Base64-encode bytes in chunks so a large image doesn't blow the call stack. */
function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
