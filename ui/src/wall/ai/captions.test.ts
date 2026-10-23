import { describe, expect, it } from "vitest";
import { cleanCaption, rms } from "./captions";

describe("captions helpers", () => {
  it("drops Whisper noise and hallucinations", () => {
    for (const s of ["", "  ", "[BLANK_AUDIO]", "(music)", " Thank you.", "...", "you"]) expect(cleanCaption(s)).toBeNull();
    expect(cleanCaption("  Hello   everyone,\n welcome ")).toBe("Hello everyone, welcome");
  });
  it("rms", () => {
    expect(rms(new Float32Array(10))).toBe(0);
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
  });
});

import { cleanPost } from "../feed";
import { parseWallMessage } from "../model";

describe("caption protocol", () => {
  const base = { id: "m" + "a".repeat(16), kind: "msg", by: "peer:1", at: 1, text: "🎙️ hello", reactions: {} };
  it("keeps a caption marker on messages only", () => {
    const id = base.id;
    const ok = cleanPost({ ...base, caption: { sid: "s1", en: true } }, () => null);
    expect(ok?.caption).toEqual({ sid: "s1", en: true });
    expect(cleanPost({ ...base, id, kind: "poll", caption: { sid: "s1" } }, () => null)).toBeNull();
    expect(cleanPost({ ...base, caption: { sid: 5 } }, () => null)).toBeNull();
  });
  it("live message carries the captions mode; older form still parses", () => {
    expect(parseWallMessage({ t: "live", streams: [], captions: { en: false } })).toEqual({ t: "live", streams: [], captions: { en: false } });
    expect(parseWallMessage({ t: "live", streams: [] })).toEqual({ t: "live", streams: [] });
    expect(parseWallMessage({ t: "live", streams: [], captions: { en: "yes" } })).toBeNull();
  });
});
