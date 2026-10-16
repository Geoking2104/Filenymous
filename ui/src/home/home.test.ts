// @vitest-environment node
import { describe, expect, it } from "vitest";
import fr from "../i18n/locales/fr.json";
import en from "../i18n/locales/en.json";
import { serviceRoute } from "./routes";
import { carouselKeyTarget, nearestSlide } from "./Carousel";

describe("home service cards copy", () => {
  it("each service has a title, a lead and exactly 3 benefits in FR and EN", () => {
    for (const loc of [fr, en] as Array<{ home: Record<string, Record<string, string> | string> }>) {
      for (const svc of ["send", "drop", "secret", "whistle", "cli", "pro", "stream"]) {
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
    expect(serviceRoute("#report-new")).toBe("report-new");
    expect(serviceRoute("#report-inbox")).toBe("report-inbox");
    expect(serviceRoute("#report-follow")).toBe("report-follow");
    expect(serviceRoute(`#report:${"A".repeat(22)}/${"B".repeat(87)}`)).toBe("report-submit");
    expect(serviceRoute("#report:short/key")).toBe("home");
  });
});

describe("carousel", () => {
  it("maps keys to slide indexes and clamps at the ends", () => {
    expect(carouselKeyTarget("ArrowRight", 0, 7)).toBe(1);
    expect(carouselKeyTarget("ArrowRight", 6, 7)).toBe(6);
    expect(carouselKeyTarget("ArrowLeft", 0, 7)).toBe(0);
    expect(carouselKeyTarget("End", 2, 7)).toBe(6);
    expect(carouselKeyTarget("Home", 5, 7)).toBe(0);
    expect(carouselKeyTarget("Enter", 1, 7)).toBeNull();
  });
  it("finds the nearest slide", () => {
    expect(nearestSlide(0, [0, 300, 600])).toBe(0);
    expect(nearestSlide(320, [0, 300, 600])).toBe(1);
    expect(nearestSlide(9999, [0, 300, 600])).toBe(2);
  });
  it("coming-soon cards have honest, translated teasers and badges", () => {
    for (const loc of [fr, en] as Array<{ home: Record<string, any> }>) {
      expect(loc.home.soon).toBeTruthy();
      for (const id of ["whistle"]) expect(loc.home[id].teaser).toBeTruthy();
      const w = JSON.stringify(loc.home.whistle).toLowerCase();
      for (const bad of ["anonymat absolu", "absolute anonymity", "certifi", "iso 27001", "iso27001", "masqu"]) expect(w).not.toContain(bad);
    }
  });
});
