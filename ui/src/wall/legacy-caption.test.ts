import { describe, expect, it } from "vitest";
import { cleanPost } from "./feed";
import { parseWallMessage } from "./model";

// Live captions were removed; posts and `live` messages from older hosts that
// still carry the fields must keep parsing (shown as plain messages).
describe("legacy caption fields", () => {
  const base = { id: "m" + "a".repeat(16), kind: "msg", by: "peer:1", at: 1, text: "🎙️ hello", reactions: {} };
  it("accepts a caption marker on messages only", () => {
    expect(cleanPost({ ...base, caption: { sid: "s1", en: true } }, () => null)?.text).toBe("🎙️ hello");
    expect(cleanPost({ ...base, kind: "poll", caption: { sid: "s1" } }, () => null)).toBeNull();
    expect(cleanPost({ ...base, caption: { sid: 5 } }, () => null)).toBeNull();
  });
  it("live message with or without the old captions field parses", () => {
    expect(parseWallMessage({ t: "live", streams: [], captions: { en: false } })).toMatchObject({ t: "live", streams: [] });
    expect(parseWallMessage({ t: "live", streams: [] })).toEqual({ t: "live", streams: [] });
  });
});
