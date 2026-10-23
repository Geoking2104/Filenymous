/**
 * E2E: live captions — the host goes live with a (fake) microphone playing a
 * speech sample, opts in to captions; Whisper tiny (q8, served locally via
 * page.route, never a CDN) transcribes in the host tab; a participant sees the
 * indicator and the caption post.
 * Needs the models (scripts/fetch-models.mjs) and a speech wav in MODELS_DIR/jfk.wav.
 */
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createWall, here, join, newPage, startRelay, type Relay } from "./wall-helpers";

const MODELS = process.env.MODELS_DIR || resolve(here, "../../../models-cache");
const WAV = resolve(MODELS, "jfk.wav");

test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`, "--autoplay-policy=no-user-gesture-required"],
  },
});
test.skip(!existsSync(resolve(MODELS, "Xenova/whisper-tiny/onnx/decoder_model_merged_quantized.onnx")) || !existsSync(WAV), "fetch the models and a speech sample first");

let relay: Relay;
test.beforeAll(async () => {
  relay = await startRelay();
});
test.afterAll(() => relay?.proc.kill());

test("live captions are transcribed on the host's device and shown with an indicator", async ({ browser }) => {
  test.setTimeout(240_000);
  const host = await newPage(browser, relay.url);
  const external: string[] = [];
  host.page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["localhost", "127.0.0.1"].includes(u.hostname)) external.push(u.href.slice(0, 120));
  });
  await host.page.context().grantPermissions(["camera", "microphone"]);
  await host.page.context().route(/\/models\//, (route) => {
    const p = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*?\/models\//, ""));
    const f = resolve(MODELS, p);
    if (!f.startsWith(MODELS) || !existsSync(f)) return route.fulfill({ status: 404 });
    return route.fulfill({ status: 200, body: readFileSync(f), contentType: f.endsWith(".json") ? "application/json" : "application/octet-stream" });
  });
  host.page.on("dialog", (d) => void d.accept());
  const { link } = await createWall(host.page);
  const peer = await newPage(browser, relay.url);
  await join(peer.page, link);
  await expect(peer.page.getByTestId("wall-captions-on")).toHaveCount(0);

  await host.page.getByTestId("wall-live-toggle").click();
  await host.page.getByTestId("wall-live-mic").check();
  await host.page.getByTestId("wall-live-camera").click();
  await expect(host.page.getByTestId("wall-live-tile")).toHaveCount(1, { timeout: 20_000 });

  await host.page.getByTestId("wall-captions-toggle").check();
  await expect(host.page.getByTestId("wall-captions-state")).toContainText(/(On|Activés)/, { timeout: 120_000 });
  await expect(peer.page.getByTestId("wall-captions-on")).toBeVisible({ timeout: 10_000 });

  const cap = peer.page.locator(".sw2-post.is-caption");
  await expect(cap.first()).toBeVisible({ timeout: 90_000 });
  const text = (await cap.allInnerTexts()).join(" ");
  console.log(`caption: ${text.slice(0, 200)}`);
  expect(text.toLowerCase()).toMatch(/country|americans|fellow|ask/);
  await expect(peer.page.getByTestId("wall-caption-badge").first()).toBeVisible();

  // Off: the indicator disappears for participants.
  await host.page.getByTestId("wall-captions-toggle").uncheck();
  await expect(peer.page.getByTestId("wall-captions-on")).toHaveCount(0, { timeout: 10_000 });
  expect(external.filter((u) => !u.includes("/umami/")), "no model or runtime request leaves the site").toEqual([]);
});
