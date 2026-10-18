import { describe, expect, it } from "vitest";
import { SERVICES, serviceForScreen } from "./services";
import type { Route } from "./routes";

describe("service → icon map (single source of truth)", () => {
  it("maps every service route to its card's service", () => {
    const base = { receiving: false, stream: false };
    const cases: [Route, string][] = [
      ["drop-owner", "drop"], ["drop-contrib", "drop"], ["wall-host", "wall"], ["wall-peer", "wall"],
      ["secret-new", "secret"], ["secret-reveal", "secret"], ["report-new", "report"], ["report-submit", "report"],
      ["report-inbox", "report"], ["report-follow", "report"], ["home", "send"],
    ];
    for (const [route, svc] of cases) expect(serviceForScreen(route, base), route).toBe(svc);
  });
  it("streaming and the Pro entry keep their own card icon", () => {
    expect(serviceForScreen("home", { receiving: true, stream: true })).toBe("stream");
    expect(serviceForScreen("drop-owner", { receiving: false, stream: false, via: "pro" })).toBe("pro");
    expect(serviceForScreen("drop-contrib", { receiving: false, stream: false, via: "pro" })).toBe("drop");
  });
  it("defines a glyph and a title for every card", () => {
    expect(Object.keys(SERVICES).sort()).toEqual(["cli", "drop", "pro", "report", "secret", "send", "stream", "wall"]);
  });
});
