// Directed push to an account's own devices.
//
// The send is injected rather than mocked, so these assert the real addressing and
// payload rules against the real code. Every failure here is silent in production: a
// wake that never arrives is indistinguishable from "the periodic has not run yet".

import { describe, it, expect } from "vitest";
import { HISTORY_WAKE_KIND, notifyHistoryWrite } from "./notify";

const envWith = (selfTopic: string | null, fcm = true) =>
  ({
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ push_self_topic: selfTopic, push_friend_topic: "t_friend" }),
        }),
      }),
    },
    ...(fcm
      ? { FCM_PROJECT_ID: "p", FCM_SERVICE_ACCOUNT_EMAIL: "e@x", FCM_PRIVATE_KEY: "k" }
      : {}),
  }) as never;

const capture = () => {
  const sent: unknown[][] = [];
  return { sent, send: async (...args: unknown[]) => void sent.push(args) };
};

describe("history wake push", () => {
  it("addresses the account's OWN devices, not its friends", async () => {
    const { sent, send } = capture();
    await notifyHistoryWrite(envWith("t_self"), "U1", "dev-a", send as never);
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toEqual({ topic: "t_self" });
  });

  it("carries the writing device id so that device can ignore its own write", async () => {
    // Topic fan-out reaches the writer too. Without this the device that just pushed
    // does a guaranteed-useless sync, and a single-device account wakes only itself.
    const { sent, send } = capture();
    await notifyHistoryWrite(envWith("t_self"), "U1", "dev-a", send as never);
    expect(sent[0][3]).toBe(HISTORY_WAKE_KIND);
    expect(sent[0][4]).toMatchObject({ kind: HISTORY_WAKE_KIND, srcDevice: "dev-a" });
  });

  it("collapses on the account, so queued wakes deliver once", async () => {
    const { sent, send } = capture();
    await notifyHistoryWrite(envWith("t_self"), "U1", "dev-a", send as never);
    expect(sent[0][5]).toBe("hist:U1");
  });

  it("sends nothing when the account has published no self topic", async () => {
    const { sent, send } = capture();
    await notifyHistoryWrite(envWith(null), "U1", "dev-a", send as never);
    expect(sent).toHaveLength(0);
  });

  it("sends nothing when FCM is not configured", async () => {
    // Absent secrets must degrade to "no push", never throw — this runs inside the
    // write path's waitUntil, where a throw would be invisible.
    const { sent, send } = capture();
    await notifyHistoryWrite(envWith("t_self", false), "U1", "dev-a", send as never);
    expect(sent).toHaveLength(0);
  });

  it("never throws when the push lookup fails", async () => {
    const broken = { DB: { prepare: () => { throw new Error("d1 down"); } } } as never;
    await expect(notifyHistoryWrite(broken, "U1", "dev-a")).resolves.toBeUndefined();
  });
});
