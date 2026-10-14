// @vitest-environment node
import { describe, expect, it } from "vitest";
import fr from "../i18n/locales/fr.json";
import en from "../i18n/locales/en.json";

const KEYS = ["title", "direct", "rights", "known", "illegal", "accept", "ok", "link", "notePrefix", "noteLink"] as const;

describe("terms of use strings", () => {
  it("exist and are non-empty in FR and EN", () => {
    for (const loc of [fr, en] as Array<{ terms: Record<string, string>; pz: { legal: Record<string, string> } }>) {
      for (const k of KEYS) expect(loc.terms[k]?.trim()).toBeTruthy();
      expect(loc.pz.legal.termsTitle).toBeTruthy();
      expect(loc.pz.legal.terms).toBeTruthy();
    }
  });
  it("matches the requested French wording", () => {
    expect(fr.terms.title).toBe("Conditions d’utilisation Filenymous");
    expect(fr.terms.ok).toBe("Compris !");
    expect(fr.terms.accept).toBe("En envoyant un fichier, vous confirmez avoir compris et accepté ces conditions.");
  });
});
