/**
 * Agent Vault end to end: browser (Coffre-fort › Agents) → local Holochain
 * 0.6.1 conductor running the SEPARATE "filenymous-agent-vault" app → CLI
 * runner (`filenymous vault enroll | run | status`).
 *
 * Needs a node and is skipped otherwise:
 *   hc sandbox --piped -f 9001 generate --in-process-lair -a filenymous-agent-vault \
 *     -r 9002 workdir/filenymous-agent-vault.happ network mem
 *   (cd cli && npm run build)
 *   VITE_HC_URL=ws://localhost:9002 VITE_HC_ADMIN_URL=ws://localhost:9001 \
 *   AGENT_VAULT_E2E=1 AV_ADMIN_URL=ws://localhost:9001 npx playwright test e2e/agent-vault.spec.ts
 * (see scripts/agent-vault-e2e.sh). The secret values are throwaway demo values.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUN = !!process.env.AGENT_VAULT_E2E;
const ADMIN = process.env.AV_ADMIN_URL ?? "ws://localhost:9001";
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/filenymous.js");
const SECRET = "ghp_e2eDemoValue_0123456789";
const PW = "correct horse battery staple demo";
// Unique per run: the node keeps configs from earlier runs (sealed to other browser vaults).
const CONFIG = `github-ci-${Date.now().toString(36)}`;

const clean = { ...process.env, FNY_AGENT_TOKEN: "", FNY_APP_TOKEN: "", FNY_ADMIN_URL: "", FNY_AGENT_KEY_FILE: "" };
const vault = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, "vault", ...args], { env: { ...clean, ...env }, encoding: "utf8", timeout: 60_000 });

async function onboard(page: Page) {
  await page.goto("/#safe");
  await expect(page.getByTestId("cf-onboarding")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("cf-start").click();
  await page.getByTestId("cf-master").fill(PW);
  await page.getByTestId("cf-master2").fill(PW);
  await page.getByTestId("cf-create").click();
  await expect(page.getByTestId("cf-phrase")).toBeVisible({ timeout: 30_000 });
  const words = await page.locator('[data-testid^="cf-word-"] span').allTextContents();
  await page.getByTestId("cf-phrase-ack").check();
  await page.getByTestId("cf-phrase-next").click();
  for (let i = 0; i < 3; i++) {
    const input = page.getByTestId(`cf-check-${i}`);
    await input.fill(words[Number(await input.getAttribute("data-pos"))]!);
  }
  await page.getByTestId("cf-check-submit").click();
  await expect(page.getByTestId("cf-vault")).toBeVisible({ timeout: 30_000 });
}

async function reopenAgents(page: Page) {
  await page.reload();
  await expect(page.getByTestId("cf-unlock").or(page.getByTestId("cf-vault"))).toBeVisible({ timeout: 30_000 });
  if (await page.getByTestId("cf-unlock").isVisible()) {
    await page.getByTestId("cf-unlock-pw").fill(PW);
    await page.getByTestId("cf-unlock-submit").click();
    await expect(page.getByTestId("cf-vault")).toBeVisible({ timeout: 30_000 });
  }
  await page.getByTestId("cf-tab-agents").click();
  await expect(page.getByTestId("cf-agents")).toBeVisible({ timeout: 30_000 });
}

test.describe("agent vault (browser → conductor → CLI)", () => {
  test.skip(!RUN, "set AGENT_VAULT_E2E=1 with a running node (see header)");
  test.describe.configure({ timeout: 240_000 });

  test("enroll, issue from the Coffre-fort, inject with vault run, revoke, audit", async ({ page }) => {
    page.on("dialog", (d) => void d.accept());
    const dir = mkdtempSync(join(tmpdir(), "fny-av-e2e-"));
    const keyFile = join(dir, "agent.json");

    // 1. Agent side: enrollment code.
    const enrolled = vault(["enroll", "--name", "e2e-agent", "--key-file", keyFile]);
    expect(enrolled.status, enrolled.stderr).toBe(0);
    const code = enrolled.stdout.trim();
    const fp = /Fingerprint: (fny-[0-9a-f-]+)/.exec(enrolled.stderr)![1]!;

    // 2. Owner side: vault, one login, an agent config mapping its password to GITHUB_TOKEN.
    await onboard(page);
    await page.getByTestId("cf-new").click();
    await page.getByTestId("cf-new-login").click();
    await page.getByTestId("cf-f-title").fill("GitHub CI");
    await page.getByTestId("cf-f-username").fill("ci-bot");
    await page.getByTestId("cf-f-password").fill(SECRET);
    await page.getByTestId("cf-save").click();
    await expect(page.getByTestId("cf-detail-title")).toHaveText("GitHub CI", { timeout: 15_000 });

    await page.getByTestId("cf-tab-agents").click();
    await expect(page.getByTestId("cf-agents")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("cf-agents-config").locator("summary").click();
    await page.getByTestId("cf-agents-config-name").fill(CONFIG);
    await page.getByTestId("cf-agents-addvar").click();
    await page.getByTestId("cf-agents-row-item-0").selectOption({ label: "GitHub CI" });
    await page.getByTestId("cf-agents-row-field-0").selectOption("password");
    await page.getByTestId("cf-agents-row-env-0").fill("GITHUB_TOKEN");
    await page.getByTestId("cf-agents-config-save").click();

    // 3. Issue a token to the enrolled agent (fingerprint matches the CLI's).
    await page.getByTestId("cf-agents-issue").locator("summary").click();
    await page.getByTestId("cf-agents-enroll-code").fill(code);
    await expect(page.getByTestId("cf-agents-fp")).toContainText(fp);
    await page.getByTestId("cf-agents-issue-config").selectOption({ label: CONFIG });
    await page.getByTestId("cf-agents-issue-btn").click();
    const token = await page.getByTestId("cf-agents-token-value").inputValue({ timeout: 30_000 });
    expect(token).toMatch(/^fny-agent-token:v1:/);
    expect(token).not.toContain(SECRET);
    await expect(page.getByTestId("cf-agents-token-row").filter({ hasText: "e2e-agent" }).first()).toBeVisible();

    // 4. Runner: the value is in the child's env only; names are exposed, the token is not.
    const env = { FNY_AGENT_TOKEN: token, FNY_ADMIN_URL: ADMIN };
    const probe = `process.stdout.write(JSON.stringify({v: process.env.GITHUB_TOKEN, names: process.env.FNY_AGENT_ENV_NAMES, tok: process.env.FNY_AGENT_TOKEN ?? null}))`;
    const run = vault(["run", "--key-file", keyFile, "--", process.execPath, "-e", probe], env);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ v: SECRET, names: "GITHUB_TOKEN", tok: null });
    expect(run.stderr).not.toContain(SECRET);

    const status = vault(["status", "--key-file", keyFile, "--json"], env);
    expect(status.status, status.stderr).toBe(0);
    const st = JSON.parse(status.stdout);
    expect(st).toMatchObject({ label: "e2e-agent", revoked: false, uses: 1 });
    expect(status.stdout).not.toContain(SECRET);

    // A different agent key cannot use this token.
    const other = join(dir, "other.json");
    expect(vault(["enroll", "--name", "intruder", "--key-file", other]).status).toBe(0);
    const stolen = vault(["run", "--key-file", other, "--", process.execPath, "-e", probe], env);
    expect(stolen.status).not.toBe(0);
    expect(stolen.stdout).not.toContain(SECRET);

    // 5. Revoke in the UI → the runner is refused, the command never starts.
    await reopenAgents(page);
    const newest = page.getByTestId("cf-agents-token-row").first(); // newest first
    await newest.getByTestId("cf-agents-revoke").click();
    await expect(newest.getByTestId("cf-agents-revoke")).toHaveCount(0, { timeout: 30_000 });
    const after = vault(["run", "--key-file", keyFile, "--", process.execPath, "-e", probe], env);
    expect(after.status).not.toBe(0);
    expect(after.stdout).toBe("");

    // 6. Audit log in the UI: issued, fetch, revoked.
    await reopenAgents(page);
    for (const kind of ["Issued", "Fetch", "Revoked"]) await expect(page.getByTestId(`cf-agents-audit-${kind}`).first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: join(process.env.AV_SHOTS ?? "test-results", "agent-vault-e2e.png"), fullPage: true });
  });
});
