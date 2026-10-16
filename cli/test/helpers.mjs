import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
export const CLI = resolve(here, "../dist/filenymous.js");
export const RELAY = resolve(here, "../../p2p-signal/server.js");

/** Compiles a TS module from src/ for unit tests. */
export async function importSrc(name) {
  const dir = mkdtempSync(join(tmpdir(), "fncli-"));
  const out = join(dir, `${name}.mjs`);
  await build({ entryPoints: [resolve(here, `../src/${name}.ts`)], outfile: out, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  return import(out);
}

export async function startRelay() {
  const port = 19000 + Math.floor(Math.random() * 3000);
  const proc = spawn(process.execPath, [RELAY], { env: { ...process.env, PORT: String(port), STUN_URLS: "" }, stdio: "pipe" });
  await new Promise((ok, ko) => {
    const t = setTimeout(() => ko(new Error("relay did not start")), 10_000);
    proc.stdout.on("data", (d) => String(d).includes("listening") && (clearTimeout(t), ok()));
  });
  return { url: `ws://127.0.0.1:${port}`, stop: () => proc.kill() };
}

/** Runs the CLI; resolves {code, stdout, stderr}. onLine gets stdout lines as they arrive. */
export function runCli(args, { env = {}, onLine } = {}) {
  const proc = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let buf = "";
  proc.stdout.on("data", (d) => {
    stdout += d;
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      onLine?.(line);
    }
  });
  proc.stderr.on("data", (d) => (stderr += d));
  const done = new Promise((ok) => proc.on("exit", (code) => ok({ code, stdout, stderr })));
  return { proc, done };
}

export function firstJson(predicate = () => true) {
  let resolveFn;
  const promise = new Promise((r) => (resolveFn = r));
  return {
    promise,
    onLine: (line) => {
      try {
        const obj = JSON.parse(line);
        if (predicate(obj)) resolveFn(obj);
      } catch { /* not json */ }
    },
  };
}
