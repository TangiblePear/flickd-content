export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

// Minimal JWT builder for Google OAuth2 using Web Crypto API
async function getGoogleAccessToken(config: FcmConfig): Promise<string | null> {
  try {
    const header = { alg: "RS256", typ: "JWT" };
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 3600;
    const claimSet = {
      iss: config.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      exp,
      iat,
    };

    const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const encodedClaimSet = btoa(JSON.stringify(claimSet)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const unsignedJwt = `${encodedHeader}.${encodedClaimSet}`;

    const pemHeader = "-----BEGIN PRIVATE KEY-----";
    const pemFooter = "-----END PRIVATE KEY-----";
    const pemContents = config.privateKey
      .replace(pemHeader, "")
      .replace(pemFooter, "")
      .replace(/\\n/g, "")
      .replace(/\\r/g, "")
      .replace(/\s/g, "");
    
    const binaryDerString = atob(pemContents);
    const binaryDer = new Uint8Array(binaryDerString.length);
    for (let i = 0; i < binaryDerString.length; i++) {
      binaryDer[i] = binaryDerString.charCodeAt(i);
    }

    const key = await crypto.subtle.importKey(
      "pkcs8",
      binaryDer,
      { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsignedJwt)
    );

    const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    const jwt = `${unsignedJwt}.${encodedSignature}`;

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });

    if (!response.ok) {
        console.error("FCM auth failed", await response.text());
        return null;
    }
    const data = await response.json() as { access_token: string };
    return data.access_token;
  } catch (e) {
    console.error("Failed to get FCM access token", e);
    return null;
  }
}

// An FCM v1 message targets exactly one of a device `token` or a `topic`. Topic
// fan-out is what makes push O(1) instead of O(friends): the Worker publishes
// once and Google delivers to every subscribed device (see 0a-1).
export type FcmTarget = { token: string } | { topic: string };

// FCM topic names accept `[a-zA-Z0-9-_.~%]+`. Validate before use so a malformed
// or hostile push record can never inject into the send.
const FCM_TOPIC_RE = /^[a-zA-Z0-9._~%-]{1,256}$/;

/**
 * Pick a send target from a stored push record. `prefer` selects which topic to
 * use — `"friend"` for ambient profile fan-out (friends subscribe), `"self"` for
 * directed messages (the owner's own devices subscribe). Falls back to a legacy
 * raw device `token` when the topic is absent (a pre-topics client that hasn't
 * republished `push.json` yet), and to null when neither is usable.
 */
export function pickFcmTarget(
  record: { selfTopic?: unknown; friendTopic?: unknown; token?: unknown } | null,
  prefer: "self" | "friend",
): FcmTarget | null {
  if (!record) return null;
  const topic = prefer === "self" ? record.selfTopic : record.friendTopic;
  if (typeof topic === "string" && FCM_TOPIC_RE.test(topic)) return { topic };
  if (typeof record.token === "string" && record.token) return { token: record.token };
  return null;
}

export async function sendFcmMessage(config: FcmConfig, target: FcmTarget, friendId: string, type: string = "social_update") {
  const accessToken = await getGoogleAccessToken(config);
  if (!accessToken) return;

  const message = {
    message: {
      ...target,
      data: {
        type,
        friendId,
      },
      android: {
        priority: "high"
      }
    }
  };

  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
  
  if (!response.ok) {
    console.error("FCM send failed", await response.text());
  }
}
