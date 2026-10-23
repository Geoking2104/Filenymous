/**
 * E2E: on-device AI in the host tab — semantic wall search with a self-hosted
 * MiniLM (served here from a local cache via page.route, never a CDN), scoped
 * for a limited-view agent with the "search" permission.
 * Needs the models: node scripts/fetch-models.mjs --out ../models-cache (from repo root: scripts/).
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createWall, here, newPage, say, startRelay, type Relay } from "./wall-helpers";

const MODELS = process.env.MODELS_DIR || resolve(here, "../../../models-cache");
const CLI = resolve(here, "../../cli/dist/filenymous.js");
type Line = Record<string, unknown> & { event?: string };

interface Agent {
  proc: ChildProcess;
  lines: Line[];
  exited: Promise<number | null>;
  send(o: Record<string, unknown>): void;
  wait(pred: (l: Line) => boolean, ms?: number): Promise<Line>;
}

const procs = new Set<ChildProcess>();
function agent(relay: Relay, args: string[]): Agent {
  const proc = spawn(process.execPath, [CLI, "wall", ...args, "--signal", relay.url, "--app-url", "http://localhost:5173/", "--quiet"], { stdio: ["pipe", "pipe", "pipe"] });
  procs.add(proc);
  const lines: Line[] = [];
  let buf = "";
  proc.stdout!.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      try {
        lines.push(JSON.parse(buf.slice(0, i)));
      } catch {
        /* ignore */
      }
      buf = buf.slice(i + 1);
    }
  });
  const exited = new Promise<number | null>((ok) => proc.on("exit", (c) => (procs.delete(proc), ok(c))));
  return {
    proc,
    lines,
    exited,
    send: (o) => proc.stdin!.write(`${JSON.stringify(o)}\n`),
    async wait(pred, ms = 20_000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const x = lines.find(pred);
        if (x) return x;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`agent timeout; lines: ${JSON.stringify(lines).slice(-800)}`);
    },
  };
}

let relay: Relay;
test.describe.configure({ mode: "serial" });
test.skip(!existsSync(CLI), "build the CLI first (cd cli && npm run build)");
test.skip(!existsSync(resolve(MODELS, "Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx")), "fetch the models first");
test.beforeAll(async () => {
  relay = await startRelay();
});
test.afterAll(() => {
  for (const p of procs) p.kill("SIGKILL");
  relay?.proc.kill();
});

test("semantic wall_search runs in the host tab with local models, scoped to what the agent may see", async ({ browser }) => {
  test.setTimeout(180_000);
  const host = await newPage(browser, relay.url);
  const external: string[] = [];
  host.page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["localhost", "127.0.0.1"].includes(u.hostname)) external.push(u.href.slice(0, 120));
  });
  await host.page.context().route(/\/models\//, (route) => {
    const p = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*?\/models\//, ""));
    const f = resolve(MODELS, p);
    if (!f.startsWith(MODELS) || !existsSync(f)) return route.fulfill({ status: 404 });
    return route.fulfill({ status: 200, body: readFileSync(f), contentType: f.endsWith(".json") ? "application/json" : "application/octet-stream" });
  });
  host.page.on("dialog", (d) => void d.accept());
  const { link } = await createWall(host.page, { agents: true });
  await say(host.page, "The quarterly report is due Friday before noon.");
  await say(host.page, "Who brings the croissants tomorrow?");

  await host.page.getByTestId("wall-semantic-toggle").check();
  await expect(host.page.getByTestId("wall-semantic-state")).toContainText(/(On|Activée)/, { timeout: 120_000 });

  const a = agent(relay, ["join", link, "--name", "Chercheur"]);
  await expect(host.page.getByTestId("wall-agent-pending")).toBeVisible();
  const card = host.page.getByTestId("wall-agent-pending");
  await card.getByTestId("wall-scope-limited").check();
  await card.getByTestId("wall-scope-search").check();
  await card.getByTestId("wall-agent-approve").click();
  await a.wait((l) => l.event === "ready");
  a.send({ cmd: "read", ref: "r" });
  const read = await a.wait((l) => l.ref === "r");
  expect(JSON.stringify(read)).not.toContain("quarterly");
  a.send({ cmd: "search", q: "deadline for the document", k: 2, ref: "s" });
  const r = (await a.wait((l) => l.ref === "s", 60_000)) as { ok: boolean; mode: string; hits: Array<{ snippet: string }> };
  expect(r.ok).toBe(true);
  expect(r.mode).toBe("semantic");
  expect(r.hits[0]?.snippet).toContain("quarterly");
  // Only the site's existing analytics script is off-host; no model/runtime CDN.
  expect(external.filter((u) => !u.includes("/umami/")), "no model or runtime request leaves the site").toEqual([]);
});
