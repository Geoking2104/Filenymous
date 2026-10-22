import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { installBrowserShims } from "./env";
import { openFileSource, type FileLike } from "./fileSource";
import { FsSink } from "./fsSink";
import { DEFAULT_APP_URL, DEFAULT_SIGNAL_URL, formatBytes, parseDuration, webhookPayload, type ShareEvent, type WebhookPayload } from "./options";
import { buildShareLink, parseShareInput } from "../../ui/src/p2p/protocol";
import { P2PReceiver, P2PSender, type ReceiverState, type SenderState } from "../../ui/src/p2p/session";
import { WallAgent, runJsonl, runMcp, startHttpBridge } from "./wall";

declare const __VERSION__: string;

const HELP = `filenymous ${__VERSION__} — end-to-end encrypted P2P file sharing (no server storage)

Usage:
  filenymous upload <file...> [options]     share files; stays online until done
  filenymous receive <link|code> [options]  download a share into a directory
  filenymous wall join <link> [options]     join a Sharewall as an AI agent (JSON Lines)
  filenymous wall create [options]          host a new Sharewall from this process
  filenymous wall mcp <link> | --create     MCP server (stdio) for AI agents

upload options:
  --ttl <dur>             how long the share stays online (default 1h; e.g. 90s, 15m, 2d)
  --max-downloads <n>     exit after n completed downloads (default 1)
  --password <pw>         require a password (prefer env FILENYMOUS_PASSWORD)
  --webhook <url>         POST JSON events (share.created, download.completed, share.expired)
  --webhook-no-link       omit link and code from webhook payloads
  --expires <iso-date>    bind an expiry into the link (e.g. 2026-10-20T18:00:00Z);
                          recipients see a countdown, nobody can connect after it
  --stream                let web recipients play audio/video while it downloads
  --allow-empty           exit 0 even if the TTL expires with zero downloads (default exit 2)
  --json                  machine-readable JSON lines on stdout
  --app-url <url>         web app base for links (default ${DEFAULT_APP_URL})

receive options:
  -o, --output <dir>      destination directory (default .)
  --password <pw>         password for protected shares (or env FILENYMOUS_PASSWORD)
  --timeout <dur>         give up if nothing completes in time (default 30m)
  --json                  machine-readable JSON lines on stdout

wall options (agents show an "AI" badge; it is self-declared):
  --name <name>           display name (default "Agent <pseudonym>")
  --password <pw>         wall password (prefer env FILENYMOUS_PASSWORD)
  --http                  also serve a local HTTP/SSE bridge on 127.0.0.1
                          (random bearer token, printed once in the "http" event)
  --http-port <n>         port for --http (default: random)
  --files-root <dir>      directory files may be sent from (default .)
  -o, --output <dir>      where explicit "get" saves files (default .)
  create: --title <wall name>, --burn, --keep-on-leave, --allow-agents,
          --agent-scope read-only|post|full|post,files,secrets,limited (default full)
          (no lifetime by default: the wall lives as long as this process;
           optional --ttl 15m|1h|24h also ends it at a fixed time)
  JSON Lines: events on stdout (ready, message, file, note, poll, reaction, join,
  leave, removed, pin, notice, ended); commands on stdin, e.g.
  {"cmd":"send","text":"hello"} {"cmd":"react","id":"…","emoji":"👍"}
  {"cmd":"file","path":"report.pdf"} {"cmd":"get","id":"…"} {"cmd":"leave"}
  {"cmd":"notes"} {"cmd":"write-note","title":"…","text":"…"} (shared notes)
  Everything an agent reads is sent to its model provider.

common:
  --signal <wss-url>      signaling relay (default ${DEFAULT_SIGNAL_URL})
  -q, --quiet             no progress on stderr
  -h, --help, -v, --version
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ttl: { type: "string" },
    "max-downloads": { type: "string" },
    password: { type: "string" },
    webhook: { type: "string" },
    "webhook-no-link": { type: "boolean" },
    "allow-empty": { type: "boolean" },
    stream: { type: "boolean" },
    expires: { type: "string" },
    json: { type: "boolean" },
    "app-url": { type: "string" },
    signal: { type: "string" },
    output: { type: "string", short: "o" },
    timeout: { type: "string" },
    quiet: { type: "boolean", short: "q" },
    name: { type: "string" },
    burn: { type: "boolean" },
    "keep-on-leave": { type: "boolean" },
    title: { type: "string" },
    "allow-agents": { type: "boolean" },
    "agent-scope": { type: "string" },
    http: { type: "boolean" },
    "http-port": { type: "string" },
    "files-root": { type: "string" },
    create: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

const err = (s: string) => process.stderr.write(`${s}\n`);
const emit = (obj: Record<string, unknown>) => o.json && process.stdout.write(`${JSON.stringify(obj)}\n`);
let lastProgress = 0;
function progress(label: string, done: number, total: number) {
  if (o.quiet || !process.stderr.isTTY && Date.now() - lastProgress < 2000) return;
  if (Date.now() - lastProgress < 250 && done < total) return;
  lastProgress = Date.now();
  const pct = total ? Math.floor((done / total) * 100) : 100;
  const line = `${label} ${pct}% (${formatBytes(done)} / ${formatBytes(total)})`;
  if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${line}`);
  else err(line);
}
const endProgress = () => process.stderr.isTTY && !o.quiet && lastProgress && process.stderr.write("\n");

async function postWebhook(url: string, payload: WebhookPayload) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": `filenymous-cli/${__VERSION__}` }, body: JSON.stringify(payload), signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) err(`warning: webhook answered HTTP ${res.status}`);
  } catch (e) {
    err(`warning: webhook failed: ${(e as Error).message}`);
  }
}

async function upload(paths: string[]): Promise<number> {
  if (!paths.length) throw new Error("upload: missing file (try: filenymous upload app.zip --ttl 1h)");
  let expires: number | undefined;
  if (o.expires) {
    const at = Date.parse(o.expires);
    if (!Number.isFinite(at) || at <= Date.now() + 2000) throw new Error("--expires must be an ISO date in the future");
    expires = Math.floor(at / 1000);
  }
  // --expires also ends the process at that time (unless --ttl is shorter).
  const ttlMs = expires && !o.ttl ? expires * 1000 - Date.now() : Math.min(parseDuration(o.ttl ?? "1h"), expires ? expires * 1000 - Date.now() : Infinity);
  const maxDownloads = Number(o["max-downloads"] ?? 1);
  if (!Number.isInteger(maxDownloads) || maxDownloads < 1) throw new Error("--max-downloads must be a positive integer");
  const password = o.password ?? process.env.FILENYMOUS_PASSWORD ?? undefined;
  const files: FileLike[] = [];
  for (const p of paths) files.push(await openFileSource(resolve(p)));
  const total = files.reduce((n, f) => n + f.size, 0);
  const fileLabel = files.length === 1 ? files[0]!.name : files.map((f) => f.name).join(", ");
  const expiresAt = new Date(expires ? expires * 1000 : Date.now() + ttlMs).toISOString();

  let downloads = 0;
  let finish: (code: number) => void = () => undefined;
  const done = new Promise<number>((r) => (finish = r));
  const sender = new P2PSender(files as unknown as File[], (s: SenderState) => {
    if (s.status === "transferring") progress("sending", s.confirmedBytes, s.totalBytes);
    if (s.downloads > downloads) {
      downloads = s.downloads;
      endProgress();
      lastProgress = 0;
      if (!o.quiet) err(`✓ download ${downloads}/${maxDownloads} completed${s.peerDevice ? ` (${s.peerDevice})` : ""}`);
      void event("download.completed").then(() => downloads >= maxDownloads && setTimeout(() => finish(0), 1600));
    } else if (s.status === "failed" && s.error === "too-many-attempts") {
      err("✗ too many wrong passwords: share locked");
      void event("share.failed", s.error).then(() => finish(1));
    } else if (s.status === "failed" && s.error && !o.quiet) {
      endProgress();
      lastProgress = 0;
      err(`… transfer interrupted (${s.error}); still waiting for a recipient`);
    }
  }, { password, stream: !!o.stream, expires });
  const link = buildShareLink(o["app-url"] ?? process.env.FILENYMOUS_APP_URL ?? DEFAULT_APP_URL, sender.code, sender.secret, expires);

  async function event(name: ShareEvent, error?: string) {
    const payload: WebhookPayload = { event: name, link, code: sender.code, file: fileLabel, size: total, expiresAt, downloads, maxDownloads, protected: !!password, ...(error ? { error } : {}) };
    emit(payload as unknown as Record<string, unknown>);
    if (o.webhook) await postWebhook(o.webhook, webhookPayload(payload, !!o["webhook-no-link"]));
  }

  await sender.start();
  if (!o.json) process.stdout.write(`${link}\n`);
  if (!o.quiet) {
    err(`Filenymous — ${fileLabel} (${formatBytes(total)})${password ? ", password-protected" : ""}`);
    err(`code: ${sender.code}   expires: ${expiresAt}   downloads: 0/${maxDownloads}`);
    err("Keep this process running: files go directly to the recipient, nothing is stored on a server.");
  }
  await event("share.created");

  const ttl = setTimeout(() => {
    void event("share.expired").then(() => finish(downloads > 0 || o["allow-empty"] ? 0 : 2));
  }, ttlMs);
  const onSig = () => finish(130);
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  const code = await done;
  clearTimeout(ttl);
  if (code === 2 && !o.quiet) err("share expired with no download");
  sender.stop();
  for (const f of files) await f.close();
  return code;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((r) => rl.question(question, (a) => { rl.close(); r(a); }));
}

async function receive(input: string | undefined): Promise<number> {
  const parsed = parseShareInput(input ?? "");
  if (!parsed) throw new Error("receive: give a Filenymous link (…#p2p:123-456-ABC/secret) or a code");
  const dir = resolve(o.output ?? ".");
  const timeoutMs = parseDuration(o.timeout ?? "30m");
  let password = o.password ?? process.env.FILENYMOUS_PASSWORD ?? undefined;
  const sink = new FsSink(dir);
  let finish: (code: number) => void = () => undefined;
  const done = new Promise<number>((r) => (finish = r));
  let announced = false;
  let triedPassword = false;
  const receiver: P2PReceiver = new P2PReceiver(parsed.code, parsed.secret, (s: ReceiverState) => {
    switch (s.status) {
      case "waiting-sender":
        if (!announced && !o.quiet) err(`waiting for the sender of ${parsed.code}…`);
        announced = true;
        break;
      case "password":
        if (s.authChecking) break;
        if (s.authError && (triedPassword && (o.password || process.env.FILENYMOUS_PASSWORD || !process.stdin.isTTY))) {
          err(`✗ wrong password (${s.authRemaining ?? 0} attempts left)`);
          finish(1);
          break;
        }
        void (async () => {
          if (!password || s.authError) {
            if (!process.stdin.isTTY) { err("✗ this share needs a password (--password or FILENYMOUS_PASSWORD)"); return finish(1); }
            password = await ask(s.authError ? `wrong password (${s.authRemaining} left), try again: ` : "password: ");
          }
          triedPassword = true;
          await receiver.submitPassword(password);
        })();
        break;
      case "ready":
        if (!o.quiet) err(`receiving ${s.files.length} file(s), ${formatBytes(s.totalBytes)}${s.peerDevice ? ` from ${s.peerDevice}` : ""} → ${dir}`);
        receiver.download(sink);
        break;
      case "receiving":
        progress("receiving", s.receivedBytes, s.totalBytes);
        break;
      case "complete":
        endProgress();
        for (const p of sink.written) o.json ? emit({ event: "file.received", path: p }) : process.stdout.write(`${p}\n`);
        emit({ event: "download.completed", files: sink.written, size: s.totalBytes });
        // Let the completion ack reach the sender before closing (same delay as the web app).
        setTimeout(() => finish(0), 5200);
        break;
      case "error":
        endProgress();
        err(s.error === "expired" ? "✗ this link has expired" : `✗ ${s.error ?? "error"}`);
        emit({ event: "error", error: s.error });
        finish(1);
        break;
    }
  }, undefined, undefined, parsed.expires);
  const timer = setTimeout(() => { err("✗ timeout"); finish(1); }, timeoutMs);
  process.once("SIGINT", () => finish(130));
  void receiver.start();
  const code = await done;
  clearTimeout(timer);
  receiver.close();
  return code;
}

async function wall(rest: string[]): Promise<number> {
  const [sub, link] = rest;
  const out = (obj: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const agent = new WallAgent({
    name: o.name,
    password: o.password ?? process.env.FILENYMOUS_PASSWORD ?? undefined,
    appUrl: o["app-url"] ?? process.env.FILENYMOUS_APP_URL ?? DEFAULT_APP_URL,
    ttl: o.ttl,
    title: o.title,
    burn: !!o.burn,
    keepOnLeave: !!o["keep-on-leave"],
    allowAgents: !!o["allow-agents"],
    agentScope: typeof o["agent-scope"] === "string" ? o["agent-scope"] : undefined,
    filesRoot: o["files-root"],
    output: o.output,
    quiet: o.quiet,
  });
  const quit = () => void agent.close().finally(() => process.exit(0));
  process.once("SIGINT", quit);
  process.once("SIGTERM", quit);

  if (sub === "mcp") {
    if (!o.create && !link) throw new Error("wall mcp: give an invite link, or --create to host a new wall");
    return runMcp(agent, () => (o.create ? agent.create() : agent.join(link!)));
  }
  if (sub !== "join" && sub !== "create") throw new Error("wall: use `wall join <link>`, `wall create` or `wall mcp <link>`");
  if (sub === "join" && !link) throw new Error("wall join: missing invite link");
  let info: Record<string, unknown>;
  try {
    info = sub === "create" ? await agent.create() : await agent.join(link!);
  } catch (e) {
    out({ event: "error", error: String((e as Error).message || e) });
    return 1;
  }
  out({ event: "ready", ...info });
  if (!o.quiet) {
    if (sub === "create") err(`Sharewall hosted by this process — invite link in the "ready" event. Code: ${agent.code}. Closing the process destroys it${o["keep-on-leave"] ? " (unless --keep-on-leave)" : ""}.`);
    else err(`Joined the wall as ${String(info.label)} (code ${agent.code}). Everything this agent reads is sent to its model provider.`);
  }
  if (o.http) {
    const http = await startHttpBridge(agent, Number(o["http-port"] ?? 0) || 0);
    out({ event: "http", url: http.url, token: http.token, endpoints: ["GET /events (SSE)", "GET /messages?since=", "GET /participants", "GET /info", "POST /send", "POST /react", "POST /file", "POST /note", "POST /vote", "POST /poll", "POST /get"] });
  }
  return runJsonl(agent, out, o.quiet);
}

async function main(): Promise<number> {
  if (o.version) { process.stdout.write(`${__VERSION__}\n`); return 0; }
  const [cmd, ...rest] = positionals;
  if (o.help || !cmd) { process.stdout.write(HELP); return cmd || o.help ? 0 : 1; }
  installBrowserShims(o.signal ?? process.env.FILENYMOUS_SIGNAL_URL ?? DEFAULT_SIGNAL_URL);
  if (cmd === "upload" || cmd === "send") return upload(rest);
  if (cmd === "receive" || cmd === "get") return receive(rest[0]);
  if (cmd === "wall") return wall(rest);
  err(`unknown command: ${cmd}\n`);
  process.stdout.write(HELP);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => { err(`✗ ${(e as Error).message || e}`); process.exit(1); },
);
