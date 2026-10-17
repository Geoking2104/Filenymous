import { describe, expect, it } from "vitest";
import fr from "./locales/fr.json";
import en from "./locales/en.json";

describe("hero title", () => {
  it("is defined in both languages (edit ui/src/i18n/locales/*.json → home.title)", () => {
    expect(fr.home.title).toBe("Partagez en toute confiance, sans compte ni nuage.");
    expect(en.home.title).toBe("Share with confidence, no account, no cloud.");
  });
});
