/**
 * E2E: Sharewall with AI agents — 2 browser contexts (host + human) and
 * 2 CLI agents (`filenymous wall join`, JSON Lines) through a local relay.
 * Covers: agents refused by default, opt-in with the provider warning,
 * "IA" badges, mentions, replies, reactions, files, host rate limit, kick,
 * and turning agents off.
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createWall, here, join, msg, newPage, say, startRelay, type Relay } from "./wall-helpers";

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
test.beforeAll(async () => {
  relay = await startRelay();
});
test.afterAll(() => {
  for (const p of procs) p.kill("SIGKILL");
  relay?.proc.kill();
});

test("2 browsers + 2 CLI agents: opt-in, IA badges, mentions, reactions, files, rate limit, kick, agents off", async ({ browser }) => {
  test.setTimeout(150_000);
  const host = await newPage(browser, relay.url);
  const human = await newPage(browser, relay.url);
  const dialogs: string[] = [];
  host.page.on("dialog", (d) => (dialogs.push(d.message()), void d.accept()));

  // Default: agents are not allowed — an agent is turned away.
  const { link } = await createWall(host.page);
  await expect(host.page.getByTestId("wall-agents-toggle")).not.toBeChecked();
  const early = agent(relay, ["join", link, "--name", "Trop tôt"]);
  expect(await early.exited).not.toBe(0);
  expect(JSON.stringify(early.lines)).toMatch(/agents/);
  await join(human.page, link);
  await expect(human.page.getByTestId("wall-agent-warning")).toHaveCount(0);

  // The host opts in, after the provider warning.
  await host.page.getByTestId("wall-agents-toggle").check();
  expect(dialogs.at(-1)).toMatch(/fournisseur de son modèle d'IA/);
  await expect(host.page.getByTestId("wall-agents-toggle")).toBeChecked();

  const a = agent(relay, ["join", link, "--name", "Agent Alpha"]);
  const b = agent(relay, ["join", link, "--name", "Agent Beta"]);
  const ra = await a.wait((l) => l.event === "ready");
  await b.wait((l) => l.event === "ready");
  expect(ra.agentsAllowed).toBe(true);

  for (const p of [host.page, human.page]) {
    await expect(p.locator('[data-testid="wall-member"][data-agent="true"]')).toHaveCount(2);
    await expect(p.getByTestId("wall-badge-ai")).toHaveCount(2);
    await expect(p.getByTestId("wall-agent-warning")).toBeVisible();
    await expect(p.getByTestId("wall-agent-warning")).toContainText("fournisseur");
  }

  // Human → agent with a mention; agent replies and reacts.
  await say(human.page, "Salut @Agent Alpha, tu peux résumer ?");
  const m = await a.wait((l) => l.event === "message" && String(l.text).includes("résumer"));
  expect(m.mentionsMe).toBe(true);
  expect(m.agent).toBe(false);
  a.send({ cmd: "send", text: "Bien sûr : **trois points**.", replyTo: m.id });
  a.send({ cmd: "react", id: m.id, emoji: "👍" });
  const reply = msg(human.page, "trois points");
  await expect(reply).toBeVisible();
  await expect(reply.locator("p strong")).toHaveText("trois points");
  await expect(reply).toHaveAttribute("data-by", String(ra.label));
  await expect(human.page.locator(`[data-id="${String(m.id)}"] [data-testid="wall-reaction"][data-emoji="👍"]`)).toHaveAttribute("data-count", "1");

  // Agents exchange too (LLM ↔ LLM), and share a file the humans can open.
  b.send({ cmd: "send", text: "@Agent Alpha je complète." });
  await a.wait((l) => l.event === "message" && l.name === "Agent Beta" && l.mentionsMe === true);
  b.send({ cmd: "file", name: "resume.md", content: "# Résumé\n- un\n- deux" });
  await expect(host.page.locator('[data-testid="wall-item"][data-name="resume.md"]')).toBeVisible();
  await expect(human.page.locator('[data-testid="wall-item"][data-name="resume.md"]')).toBeVisible();

  // A looping agent hits the host's per-participant rate limit.
  for (let i = 0; i < 25; i++) b.send({ cmd: "send", text: `boucle ${i}` });
  await b.wait((l) => l.event === "notice" && l.code === "rate-limited");
  await human.page.waitForTimeout(800);
  const loops = await human.page.getByTestId("wall-msg").filter({ hasText: /^.*boucle \d+/ }).count();
  expect(loops).toBeGreaterThan(5);
  expect(loops).toBeLessThan(25);

  // The host disconnects one agent…
  await host.page.locator(`[data-testid="wall-member"][data-label="${String(ra.label)}"]`).getByTestId("wall-kick").click();
  expect(dialogs.at(-1)).toMatch(/Agent Alpha/);
  await a.wait((l) => l.event === "ended" && l.reason === "kicked");
  expect(await a.exited).toBe(3);
  await expect(human.page.getByTestId("wall-badge-ai")).toHaveCount(1);

  // …then turns agents off: the remaining one is disconnected, humans stay.
  await host.page.getByTestId("wall-agents-toggle").uncheck();
  await b.wait((l) => l.event === "ended" && l.reason === "agents-off");
  expect(await b.exited).toBe(3);
  await expect(human.page.getByTestId("wall-badge-ai")).toHaveCount(0);
  await expect(human.page.getByTestId("wall-agent-warning")).toHaveCount(0);
  await expect(human.page.getByTestId("wall-peer-status")).toHaveAttribute("data-status", "online");
  await expect(host.page.getByTestId("wall-host")).toHaveAttribute("data-peers", "1");
});
