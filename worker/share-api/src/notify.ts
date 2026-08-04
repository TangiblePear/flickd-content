/**
 * Directed push: reaching a specific account's own devices.
 *
 * Lives in its own module rather than in `index.ts` because `history.ts` needs it and
 * `index.ts` imports `history.ts` — importing back would be a cycle. Duplicating the send
 * would be worse than moving it.
 */

import { pickFcmTarget, sendFcmMessage, type FcmConfig } from "./fcm";
import { readAccountPush } from "./push";

/**
 * The subset of the Worker environment a push needs.
 *
 * Deliberately narrow and structural: both `Env` and `HistoryEnv` satisfy it without
 * either module importing the other's type.
 */
export interface NotifyEnv {
  DB: D1Database;
  FCM_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT_EMAIL?: string;
  FCM_PRIVATE_KEY?: string;
}

/**
 * The send, injectable so tests assert real addressing without a network call.
 * Production always takes the default.
 */
export type FcmSend = typeof sendFcmMessage;

export function fcmConfig(env: NotifyEnv): FcmConfig | null {
  if (!env.FCM_PROJECT_ID || !env.FCM_SERVICE_ACCOUNT_EMAIL || !env.FCM_PRIVATE_KEY) return null;
  return {
    projectId: env.FCM_PROJECT_ID,
    clientEmail: env.FCM_SERVICE_ACCOUNT_EMAIL,
    privateKey: env.FCM_PRIVATE_KEY,
  };
}

/**
 * Wake or notify every device signed into one account.
 *
 * ⚠️ **Addressing a user has never required a friendship.** `users.push_self_topic`
 * is subscribed to by that user's own devices, so this reaches anyone — friend or
 * stranger's target alike. That is why comment-reaction notifications needed no new
 * addressing mechanism, only a caller.
 *
 * The push record itself still lives in **R2**, which is the last relay dependency
 * on this path. When the relay is retired it has to move to a D1 `device_tokens`
 * table keyed by **token** (not by user+device: a token migrates between users on a
 * shared device, and keying on the device eventually delivers one person's
 * notifications to another). Nothing above this line changes when it does.
 *
 * @param data extra `data` fields for the client to render without a round trip.
 * @param collapseKey replaces an earlier notification about the same subject rather
 *   than stacking beside it — see [sendFcmMessage].
 */
export async function notifyAccount(
  env: NotifyEnv,
  userId: string,
  data: Record<string, string> = {},
  collapseKey?: string,
  send: FcmSend = sendFcmMessage,
): Promise<void> {
  try {
    const account = await readAccountPush(env.DB, userId);
    if (!account) return;
    const config = fcmConfig(env);
    if (!config) return;

    // The relay fallback (`{friendId}/push.json`) is gone as of 9a. An account with no
    // topics is now simply unreachable by directed push until its client publishes them,
    // which every current build does on the sync after upgrading. Measured before
    // removing: 3 of 5 active accounts had no account topics and lose directed push
    // until they open an updated build — the accepted price, decided twice.
    const target = pickFcmTarget(account, "self");
    if (!target) return;
    // Still the friendId while one exists: it is the FCM message tag the client
    // correlates on, not an addressing decision.
    const friendId = userId;
    // `kind` distinguishes a rendered notification from the bare "sync now" wake
    // every other caller sends; the client switches on it.
    const type = data.kind ? data.kind : "inbox_update";
    await send(config, target, friendId, type, data, collapseKey);
  } catch (e) {
    console.error("notifyAccount failed", e);
  }
}

/**
 * The client branches on this to schedule a history pull. An older build matches no
 * branch and ignores the message, which is the whole compatibility story.
 */
export const HISTORY_WAKE_KIND = "history_update";

/**
 * Tell the account's other devices that its history document just changed.
 *
 * Without this a second device learns nothing until its next periodic pass — measured at
 * 15 min 20 s for an episode marked on a tablet to reach a phone, because the push side
 * is debounced to 30 s while the pull side had no prompt trigger at all.
 *
 * `srcDevice` is the device that performed the write. Topic fan-out cannot exclude a
 * publisher, so the receiver compares it against its own id and skips — otherwise the
 * device that just pushed immediately syncs again to be told it is current, and a
 * single-device account pays that on every write.
 *
 * The collapse key is the ACCOUNT, not the write: several wakes queued for a device that
 * is offline should deliver as one "your history changed", never as a stack of identical
 * messages each costing a sync on arrival.
 */
export async function notifyHistoryWrite(
  env: NotifyEnv,
  userId: string,
  srcDeviceId: string,
  send: FcmSend = sendFcmMessage,
): Promise<void> {
  await notifyAccount(
    env,
    userId,
    { kind: HISTORY_WAKE_KIND, srcDevice: srcDeviceId },
    `hist:${userId}`,
    send,
  );
}
