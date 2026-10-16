// @vitest-environment node
import { describe, expect, it } from "vitest";
import fr from "../i18n/locales/fr.json";
import en from "../i18n/locales/en.json";
import { serviceRoute } from "./routes";

describe("home service cards copy", () => {
  it("each service has a title, a lead and exactly 3 benefits in FR and EN", () => {
    for (const loc of [fr, en] as Array<{ home: Record<string, Record<string, string> | string> }>) {
      for (const svc of ["send", "drop", "secret"]) {
        const c = loc.home[svc] as Record<string, string>;
        expect(c.title?.trim()).toBeTruthy();
        expect(c.lead?.trim()).toBeTruthy();
        const bullets = Object.keys(c).filter((k) => /^b\d$/.test(k));
        expect(bullets).toEqual(["b1", "b2", "b3"]);
        for (const k of bullets) {
          expect(c[k]!.length).toBeLessThanOrEqual(32);
          expect(c[`${k}d`]?.trim()).toBeTruthy();
        }
      }
    }
  });
});

describe("service routes", () => {
  it("maps hashes to the shell routes", () => {
    expect(serviceRoute("")).toBe("home");
    expect(serviceRoute("#secret-new")).toBe("secret-new");
    expect(serviceRoute(`#s:${"A".repeat(22)}/${"k".repeat(43)}`)).toBe("secret-reveal");
    expect(serviceRoute("#drop-new")).toBe("drop-owner");
    expect(serviceRoute(`#drop:drop-${"a".repeat(24)}/${"s".repeat(22)}/0/n`)).toBe("drop-contrib");
    expect(serviceRoute("#p2p:123-456-ABC")).toBe("home");
  });
});
