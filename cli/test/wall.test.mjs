/** Sharewall for agents: `wall create` host + 2 `wall join` agents over a local relay (JSON Lines, HTTP bridge). */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "./helpers.mjs";
import { killAll, wallCli } from "./wall-helpers.mjs";

let relay;
before(async () => (relay = await startRelay()));
after(() => (killAll(), relay?.stop()));
const common = () => ["--signal", relay.url, "--app-url", "http://localhost:5173/", "--quiet"];

test("agents host and join a wall: messages, mentions, reactions, files, notes, polls, explicit get, leave", { timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "fnwall-"));
  writeFileSync(join(dir, "report.txt"), "rapport de l'agent");
  const host = wallCli(["create", "--allow-agents", "--name", "Hôte IA", "--title", "Labo IA", ...common()], { cwd: dir });
  const ready = await host.wait((l) => l.event === "ready");
  assert.equal(ready.role, "host");
  // No lifetime by default ("0"), destroyed when the host leaves ("h"); the name is not in the link.
  assert.match(ready.link, /^http:\/\/localhost:5173\/#wall:wall-[a-f0-9]{24}\/[A-Za-z0-9_-]{43}\/0\/nh$/);
  assert.equal(ready.expiresAt, null);
  assert.equal(ready.title, "Labo IA");
  assert.match(ready.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(!JSON.stringify(ready).includes("wall-host:"), "the host secret is never printed");

  const a = wallCli(["join", ready.link, "--name", "Agent A", ...common()], { cwd: dir });
  const b = wallCli(["join", ready.link, "--name", "Agent B", ...common()]);
  const ra = await a.wait((l) => l.event === "ready");
  const rb = await b.wait((l) => l.event === "ready");
  assert.equal(ra.code, ready.code);
  assert.equal(ra.title, "Labo IA"); // received inside the sealed welcome
  await host.wait((l) => l.event === "join" && l.name === "Agent B" && l.agent === true);

  a.send({ cmd: "send", text: "Bonjour @Agent B, **ça va** ?", ref: "m1" });
  const onB = await b.wait((l) => l.event === "message" && l.text?.includes("Bonjour"));
  assert.equal(onB.name, "Agent A");
  assert.equal(onB.agent, true);
  assert.equal(onB.self, false);
  assert.equal(onB.mentionsMe, true);
  const onA = await a.wait((l) => l.event === "message" && l.text?.includes("Bonjour"));
  assert.equal(onA.self, true, "own messages are flagged (loop guard)");
  assert.deepEqual(await a.wait((l) => l.ref === "m1"), { event: "result", ref: "m1", cmd: "send", ok: true });

  b.send({ cmd: "send", text: "Très bien !", replyTo: onB.id });
  const reply = await host.wait((l) => l.event === "message" && l.text === "Très bien !");
  assert.equal(reply.replyTo, onB.id);
  b.send({ cmd: "react", id: onB.id, emoji: "🎉" });
  const r = await a.wait((l) => l.event === "reaction" && l.emoji === "🎉");
  assert.deepEqual([r.by, r.name, r.added, r.count], [rb.label, "Agent B", true, 1]);

  // Files (from --files-root) and generated content; masked notes; nothing fetched automatically.
  a.send({ cmd: "file", path: "report.txt", ref: "f" });
  assert.equal((await a.wait((l) => l.ref === "f")).ok, true);
  a.send({ cmd: "file", path: "../../etc/passwd", ref: "bad" });
  const bad = await a.wait((l) => l.ref === "bad");
  assert.equal(bad.ok, false);
  b.send({ cmd: "file", name: "data.json", content: Buffer.from('{"x":1}').toString("base64"), base64: true });
  b.send({ cmd: "note", text: "API_KEY=sk-test-123" });
  const fileEv = await host.wait((l) => l.event === "file" && l.file?.name === "report.txt");
  const noteEv = await a.wait((l) => l.event === "note");
  assert.equal(noteEv.text, undefined, "notes stay masked until an explicit get");
  await a.wait((l) => l.event === "file" && l.file?.name === "data.json" && l.file.mime === "application/json");
  b.send({ cmd: "get", id: fileEv.id, ref: "g1" });
  assert.equal((await b.wait((l) => l.ref === "g1")).text, "rapport de l'agent");
  a.send({ cmd: "get", id: noteEv.id, ref: "g2" });
  assert.equal((await a.wait((l) => l.ref === "g2")).text, "API_KEY=sk-test-123");

  // Polls and votes.
  host.send({ cmd: "poll", question: "Format ?", options: ["JSON", "YAML"] });
  const poll = await a.wait((l) => l.event === "poll");
  a.send({ cmd: "vote", id: poll.id, option: 0 });
  b.send({ cmd: "vote", id: poll.id, option: 0 });
  const upd = await host.wait((l) => l.event === "poll.update" && l.poll.options[0].votes === 2);
  assert.equal(upd.poll.options[1].votes, 0);

  // Reading history and participants.
  a.send({ cmd: "read", since: 0, ref: "h" });
  const hist = await a.wait((l) => l.ref === "h");
  assert.ok(hist.messages.length >= 5);
  assert.deepEqual(hist.messages.map((m) => m.seq), [...hist.messages.map((m) => m.seq)].sort((x, y) => x - y));
  b.send({ cmd: "members", ref: "p" });
  const ps = (await b.wait((l) => l.ref === "p")).participants;
  assert.deepEqual(ps.map((p) => [p.name, p.agent, p.host]).sort(), [["Agent A", true, false], ["Agent B", true, false], ["Hôte IA", true, true]].sort());

  // Leaving, then the host process ends the wall for everyone.
  b.send({ cmd: "leave" });
  assert.equal(await b.exited, 0);
  await a.wait((l) => l.event === "leave" && l.name === "Agent B");
  host.send({ cmd: "leave" });
  await a.wait((l) => l.event === "ended" && l.reason === "destroyed");
  assert.equal(await a.exited, 0);
  assert.equal(await host.exited, 0);
});

test("agents are refused unless the host allows them; the host rate-limits loops", { timeout: 60_000 }, async () => {
  const host = wallCli(["create", ...common()]);
  const ready = await host.wait((l) => l.event === "ready");
  assert.equal(ready.agentsAllowed, false);
  const refused = wallCli(["join", ready.link, ...common()]);
  assert.ok(await Promise.race([refused.wait((l) => l.event === "error" || l.event === "ended"), refused.exited.then(() => true)]));
  assert.notEqual(await refused.exited, 0);

  host.send({ cmd: "allow-agents", on: true });
  const a = wallCli(["join", ready.link, "--name", "Looper", ...common()]);
  await a.wait((l) => l.event === "ready");
  for (let i = 0; i < 20; i++) a.send({ cmd: "send", text: `loop ${i}` });
  await a.wait((l) => l.event === "notice" && l.code === "rate-limited");
  await new Promise((r) => setTimeout(r, 800));
  const got = host.count((l) => l.event === "message" && /^loop /.test(l.text));
  assert.ok(got >= 8 && got < 20, `host accepted ${got} of 20`);

  // Turning agents off disconnects them.
  host.send({ cmd: "allow-agents", on: false });
  await a.wait((l) => l.event === "ended" && l.reason === "agents-off");
  assert.equal(await a.exited, 3);
  host.send({ cmd: "leave" });
  await host.exited;
});

test("local HTTP/SSE bridge: loopback only, bearer token, send + events", { timeout: 60_000 }, async () => {
  const host = wallCli(["create", "--allow-agents", ...common()]);
  const ready = await host.wait((l) => l.event === "ready");
  const a = wallCli(["join", ready.link, "--http", "--name", "HTTP Bot", ...common()]);
  await a.wait((l) => l.event === "ready");
  const { url, token } = await a.wait((l) => l.event === "http");
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(token.length >= 32);
  assert.equal((await fetch(`${url}/info`)).status, 401);
  assert.equal((await fetch(`${url}/info`, { headers: { authorization: "Bearer nope" } })).status, 401);
  assert.equal((await fetch(`${url}/info`, { headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" } })).status, 403);
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const ctrl = new AbortController();
  const sse = await fetch(`${url}/events`, { headers: auth, signal: ctrl.signal });
  assert.equal(sse.headers.get("content-type"), "text/event-stream");
  const reader = sse.body.getReader();
  let seen = "";
  const gotEvent = (async () => {
    while (!seen.includes("depuis le web")) seen += new TextDecoder().decode((await reader.read()).value);
  })();
  host.send({ cmd: "send", text: "depuis le web" });
  await gotEvent;
  assert.match(seen, /event: message\ndata: \{.*"text":"depuis le web"/);
  ctrl.abort();

  const res = await fetch(`${url}/send`, { method: "POST", headers: auth, body: JSON.stringify({ text: "via HTTP" }) });
  assert.deepEqual(await res.json(), { ok: true });
  await host.wait((l) => l.event === "message" && l.text === "via HTTP" && l.name === "HTTP Bot");
  const msgs = await (await fetch(`${url}/messages?since=0`, { headers: auth })).json();
  assert.deepEqual(msgs.messages.map((m) => m.text), ["depuis le web", "via HTTP"]);
  host.send({ cmd: "leave" });
  await a.exited;
  await host.exited;
});

test("wall password: wrong password fails, right one joins", { timeout: 60_000 }, async () => {
  const host = wallCli(["create", "--allow-agents", "--burn", ...common()], { env: { FILENYMOUS_PASSWORD: "s3cret-wall", FILENYMOUS_DEBUG: "1" } });
  const ready = await host.wait((l) => l.event === "ready");
  assert.match(ready.link, /\/p1h$/);
  assert.ok(!JSON.stringify(host.lines).includes("s3cret-wall"));
  const wrong = wallCli(["join", ready.link, ...common()], { env: { FILENYMOUS_PASSWORD: "nope" } });
  const e = await wrong.wait((l) => l.event === "error");
  assert.equal(e.error, "bad-password");
  assert.equal(await wrong.exited, 1);
  const ok = wallCli(["join", ready.link, ...common()], { env: { FILENYMOUS_PASSWORD: "s3cret-wall", FILENYMOUS_DEBUG: "1" } });
  const okReady = await ok.wait((l) => l.event === "ready", 30_000).catch((e) => {
    throw new Error(`${e.message}\nhost stderr: ${host.stderr.slice(-1500)}`);
  });
  assert.equal(okReady.burn, true);
  // Burn: the first get by someone else consumes the item.
  host.send({ cmd: "file", name: "once.txt", content: "une seule fois" });
  const f = await ok.wait((l) => l.event === "file");
  ok.send({ cmd: "get", id: f.id, ref: 1 });
  assert.equal((await ok.wait((l) => l.ref === 1)).text, "une seule fois");
  await host.wait((l) => l.event === "removed" && l.id === f.id);
  host.send({ cmd: "leave" });
  await ok.exited;
  await host.exited;
});

test("help mentions the wall commands and the provider caveat", async () => {
  const { runCli } = await import("./helpers.mjs");
  const r = await runCli(["--help"]).done;
  assert.match(r.stdout, /wall join <link>/);
  assert.match(r.stdout, /wall mcp/);
  assert.match(r.stdout, /sent to its model provider/);
  assert.match(r.stdout, /--title <wall name>/);
  assert.match(r.stdout, /no lifetime by default/);
  assert.match(readFileSync(new URL("../package.json", import.meta.url), "utf8"), /"version": "0\.4\.1"/);
});
