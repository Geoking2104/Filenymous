import { spawn } from "node:child_process";
import { CLI } from "./helpers.mjs";

const live = new Set();
process.on("exit", () => { for (const p of live) p.kill("SIGKILL"); });
/** Kills every wall process still running (call from after()). */
export function killAll() { for (const p of live) p.kill("SIGKILL"); live.clear(); }

/** Spawns `filenymous wall …` with stdin open; collects JSON lines. */
export function wallCli(args, { env = {}, cwd } = {}) {
  const proc = spawn(process.execPath, [CLI, "wall", ...args], { env: { ...process.env, ...env }, cwd, stdio: ["pipe", "pipe", "pipe"] });
  live.add(proc);
  proc.on("exit", () => live.delete(proc));
  const lines = [];
  let buf = "";
  let stderr = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { lines.push(JSON.parse(l)); } catch { lines.push({ raw: l }); }
    }
  });
  proc.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((ok) => proc.on("exit", (code) => ok(code)));
  return {
    proc,
    lines,
    exited,
    get stderr() { return stderr; },
    send: (o) => proc.stdin.write(`${JSON.stringify(o)}\n`),
    async wait(pred, ms = 20_000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const x = lines.find(pred);
        if (x) return x;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timeout waiting in ${args.join(" ")}; stderr: ${stderr.slice(-400)}; lines: ${JSON.stringify(lines).slice(-600)}`);
    },
    count: (pred) => lines.filter(pred).length,
  };
}
