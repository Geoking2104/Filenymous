import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import fr from "./locales/fr.json";

type Tree = { [k: string]: string | Tree };

function flatten(t: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[key] = v;
    else Object.assign(out, flatten(v, key));
  }
  return out;
}

const banned = /\bDHT\b|holochain|\bholo\b|mdns/i;

describe("user-facing copy", () => {
  for (const [lang, tree] of [["en", en], ["fr", fr]] as const) {
    it(`${lang}: no internal network jargon (DHT, Holochain, mDNS)`, () => {
      const hits = Object.entries(flatten(tree as Tree)).filter(([, v]) => banned.test(v));
      expect(hits).toEqual([]);
    });
  }

  it("privacy panel and transfer strings exist in both languages", () => {
    const e = flatten(en as Tree);
    const f = flatten(fr as Tree);
    for (const k of Object.keys(e).filter((k) => k.startsWith("privacyPanel.") || k.startsWith("send.") || k.startsWith("receive."))) {
      expect(f[k], k).toBeTruthy();
    }
  });
});
