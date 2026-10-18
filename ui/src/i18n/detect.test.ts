import { describe, expect, it } from "vitest";
import fr from "./locales/fr.json";
import en from "./locales/en.json";

describe("hero title", () => {
  it("is defined in both languages (edit ui/src/i18n/locales/*.json → home.title)", () => {
    expect(fr.home.title).toBe("Partage instantané et confidentiel, sans compte ni cloud.");
    expect(en.home.title).toBe("Instant share with confidence, no account, no cloud.");
  });
});
