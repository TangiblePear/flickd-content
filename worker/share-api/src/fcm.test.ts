import { describe, it, expect } from "vitest";
import { pickFcmTarget } from "./fcm";

describe("pickFcmTarget", () => {
  it("prefers the friend-topic for ambient fan-out", () => {
    const rec = { selfTopic: "t_self", friendTopic: "t_friend", token: "tok" };
    expect(pickFcmTarget(rec, "friend")).toEqual({ topic: "t_friend" });
  });

  it("prefers the self-topic for directed messages", () => {
    const rec = { selfTopic: "t_self", friendTopic: "t_friend", token: "tok" };
    expect(pickFcmTarget(rec, "self")).toEqual({ topic: "t_self" });
  });

  it("falls back to the legacy device token when the topic is absent", () => {
    expect(pickFcmTarget({ token: "tok" }, "self")).toEqual({ token: "tok" });
    expect(pickFcmTarget({ token: "tok" }, "friend")).toEqual({ token: "tok" });
  });

  it("returns null when neither a usable topic nor a token is present", () => {
    expect(pickFcmTarget(null, "self")).toBeNull();
    expect(pickFcmTarget({}, "friend")).toBeNull();
    expect(pickFcmTarget({ friendTopic: "" }, "friend")).toBeNull();
  });

  it("rejects a malformed topic name (never injects into the send)", () => {
    // A hostile record with a slash / whitespace must not be used as a topic;
    // with no token either, there is nothing to send to.
    expect(pickFcmTarget({ friendTopic: "bad/topic name" }, "friend")).toBeNull();
    // …but a token alongside a bad topic still sends to the token.
    expect(pickFcmTarget({ friendTopic: "bad topic", token: "tok" }, "friend")).toEqual({ token: "tok" });
  });
});
