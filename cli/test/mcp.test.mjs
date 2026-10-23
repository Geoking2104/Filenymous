/** MCP stdio server (`filenymous wall mcp`) driven by the official MCP client SDK. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI, startRelay } from "./helpers.mjs";
import { killAll, wallCli } from "./wall-helpers.mjs";

let relay;
before(async () => (relay = await startRelay()));
after(() => (killAll(), relay?.stop()));
const common = () => ["--signal", relay.url, "--app-url", "http://localhost:5173/"];

async function mcpClient(args) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "wall", "mcp", ...args, ...common()], stderr: "pipe" });
  const client = new Client({ name: "test-harness", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

test("MCP: tools list, read/send/react/participants/file/get between a CLI host and an MCP agent", { timeout: 90_000 }, async () => {
  const host = wallCli(["create", "--allow-agents", "--name", "Hôte", "--quiet", ...common()]);
  const ready = await host.wait((l) => l.event === "ready");
  host.send({ cmd: "send", text: "Bienvenue sur le mur" });

  const client = await mcpClient([ready.link, "--name", "Claude-ish"]);
  assert.equal(client.getServerVersion().name, "filenymous-wall");
  assert.match(client.getInstructions() ?? "", /model provider/);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["wall_add_task", "wall_delegate_task", "wall_get_item", "wall_info", "wall_list_participants", "wall_list_tasks", "wall_post_artifact", "wall_react", "wall_read_messages", "wall_read_notes", "wall_search", "wall_send_file", "wall_send_message", "wall_update_task", "wall_write_note"]);

  const info = await call(client, "wall_info");
  assert.equal(info.json.role, "peer");
  assert.equal(info.json.code, ready.code);
  await host.wait((l) => l.event === "join" && l.name === "Claude-ish" && l.agent);

  const first = await call(client, "wall_read_messages", { since: 0, wait_ms: 5000 });
  assert.equal(first.json.messages[0].text, "Bienvenue sur le mur");
  assert.equal(first.json.messages[0].self, false);
  const next = first.json.next;

  assert.deepEqual((await call(client, "wall_send_message", { text: "Bonjour, je suis un agent.", reply_to: first.json.messages[0].id })).json, { ok: true });
  const got = await host.wait((l) => l.event === "message" && l.text === "Bonjour, je suis un agent.");
  assert.equal(got.agent, true);
  assert.equal(got.replyTo, first.json.messages[0].id);

  // Long-poll: returns as soon as something new arrives.
  const t0 = Date.now();
  setTimeout(() => host.send({ cmd: "send", text: "question pour toi" }), 500);
  let polled = await call(client, "wall_read_messages", { since: next, wait_ms: 10000 });
  // Our own message may come first; ask again until the host's question shows up.
  while (!polled.json.messages.some((m) => m.text === "question pour toi")) polled = await call(client, "wall_read_messages", { since: polled.json.next, wait_ms: 10000 });
  assert.ok(Date.now() - t0 < 9000);
  const q = polled.json.messages.find((m) => m.text === "question pour toi");

  assert.deepEqual((await call(client, "wall_react", { id: q.id, emoji: "👀" })).json, { ok: true });
  await host.wait((l) => l.event === "reaction" && l.emoji === "👀" && l.name === "Claude-ish");
  const bad = await call(client, "wall_react", { id: "nope", emoji: "👀" });
  assert.equal(bad.isError, true);

  const people = (await call(client, "wall_list_participants")).json.participants;
  assert.deepEqual(people.map((p) => [p.name, p.agent, p.host, p.self]).sort(), [["Claude-ish", true, false, true], ["Hôte", true, true, false]].sort());

  assert.equal((await call(client, "wall_send_file", { name: "notes.md", content: "# Résumé\n- ok" })).json.ok, true);
  const f = await host.wait((l) => l.event === "file" && l.file?.name === "notes.md");
  assert.equal(f.file.mime, "text/markdown");
  host.send({ cmd: "note", text: "mot de passe: hunter2" });
  let note;
  for (let since = 0; !note; ) {
    const r = await call(client, "wall_read_messages", { since, wait_ms: 5000 });
    note = r.json.messages.find((m) => m.type === "note");
    since = r.json.next;
  }
  assert.equal(note.text, undefined);
  assert.equal((await call(client, "wall_get_item", { id: note.id })).json.text, "mot de passe: hunter2");

  await client.close();
  // Closing the MCP client leaves the wall.
  await host.wait((l) => l.event === "leave" && l.name === "Claude-ish");
  host.send({ cmd: "leave" });
  await host.exited;
});

test("MCP --create: an agent can host; a second MCP agent joins with the link", { timeout: 90_000 }, async () => {
  const hostAgent = await mcpClient(["--create", "--allow-agents", "--name", "Agent hôte"]);
  const info = (await call(hostAgent, "wall_info")).json;
  assert.equal(info.role, "host");
  assert.match(info.link, /#wall:wall-/);
  const guest = await mcpClient([info.link, "--name", "Agent invité"]);
  await call(guest, "wall_send_message", { text: "ping" });
  let seen = [];
  for (let since = 0, i = 0; !seen.some((m) => m.text === "ping") && i < 10; i++) {
    const r = await call(hostAgent, "wall_read_messages", { since, wait_ms: 5000 });
    seen = seen.concat(r.json.messages);
    since = r.json.next;
  }
  const ping = seen.find((m) => m.text === "ping");
  assert.equal(ping.name, "Agent invité");
  await call(hostAgent, "wall_send_message", { text: "pong" });
  let pong;
  for (let since = 0; !pong; ) {
    const r = await call(guest, "wall_read_messages", { since, wait_ms: 5000 });
    pong = r.json.messages.find((m) => m.text === "pong" && !m.self);
    since = r.json.next;
  }
  await hostAgent.close();
  // The host leaving destroys the wall (default): the guest sees it ended.
  let ended;
  for (let i = 0; i < 20 && !ended; i++) ended = (await call(guest, "wall_read_messages", { since: 99, wait_ms: 1000 })).json?.ended;
  assert.ok(ended);
  await guest.close();
});

test("MCP: shared notes with wall_read_notes / wall_write_note (host-versioned, last writer wins)", { timeout: 90_000 }, async () => {
  const host = wallCli(["create", "--allow-agents", "--name", "Hôte", "--quiet", ...common()]);
  const ready = await host.wait((l) => l.event === "ready");
  const client = await mcpClient([ready.link, "--name", "Noteur"]);
  const empty = await call(client, "wall_read_notes");
  assert.deepEqual(empty.json.notes, []);
  const created = await call(client, "wall_write_note", { title: "Ordre du jour", text: "1. **Budget**" });
  assert.equal(created.isError, false, created.text);
  const id = created.json.note.id;
  assert.match(id, /^n-[0-9a-f]{16}$/);
  const ev = await host.wait((l) => l.event === "note" && l.id === id);
  assert.equal(ev.title, "Ordre du jour");
  host.send({ cmd: "write-note", id, text: "1. Budget\n2. Planning", ref: "w1" });
  const w1 = await host.wait((l) => l.event === "result" && l.ref === "w1");
  assert.equal(w1.ok, true, JSON.stringify(w1));
  assert.ok(w1.note.version > created.json.note.version);
  let one;
  for (let i = 0; i < 40; i++) {
    one = (await call(client, "wall_read_notes", { id })).json.note;
    if (one.text.includes("Planning")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(one.text, "1. Budget\n2. Planning");
  assert.equal(one.editedBy, "host");
  const tooBig = await call(client, "wall_write_note", { id, text: "x".repeat(70 * 1024) });
  assert.equal(tooBig.isError, true);
  const bad = await call(client, "wall_write_note", { id: "../../etc", text: "x" });
  assert.equal(bad.isError, true);
  // The host can delete any note (here its own).
  host.send({ cmd: "write-note", title: "Note de l'hôte", ref: "w2" });
  const w2 = await host.wait((l) => l.event === "result" && l.ref === "w2");
  await client.close();
  host.send({ cmd: "delete-note", id: w2.note.id, ref: "d1" });
  assert.equal((await host.wait((l) => l.event === "result" && l.ref === "d1")).ok, true);
  host.send({ cmd: "leave" });
});

test("MCP: tasks, decisions, artifacts, summarize prompt; scope set by the host is reported and enforced", { timeout: 90_000 }, async () => {
  const host = wallCli(["create", "--allow-agents", "--agent-scope", "post,limited", "--name", "Hôte", "--quiet", ...common()]);
  const ready = await host.wait((l) => l.event === "ready");
  host.send({ cmd: "send", text: "Discussion privée entre humains" });
  host.send({ cmd: "note", text: "API_KEY=sk-test-123" });
  const secret = await host.wait((l) => l.event === "note");
  const client = await mcpClient([ready.link, "--name", "Résumeur"]);
  const info = await call(client, "wall_info");
  assert.deepEqual(info.json.scope, { name: "post", post: true, files: false, secrets: false, limitedView: true });
  const parts = await call(client, "wall_list_participants");
  const me = parts.json.participants.find((p) => p.self);
  assert.equal(me.scope.limitedView, true);
  // Limited view: the human-only message and the secret are not delivered.
  const read0 = await call(client, "wall_read_messages", { since: 0 });
  assert.deepEqual(read0.json.messages, []);
  host.send({ cmd: "send", text: `@Résumeur peux-tu résumer ?` });
  const r1 = await call(client, "wall_read_messages", { since: 0, wait_ms: 8000 });
  assert.equal(r1.json.messages.length, 1);
  assert.match(r1.json.messages[0].text, /résumer/);
  const denied = await call(client, "wall_get_item", { id: secret.id });
  assert.equal(denied.isError, true);
  // Context pack: the host shares the secret item; the agent sees it (but may not reveal it: no "secrets" scope).
  host.send({ cmd: "share", label: me.label, id: secret.id, ref: "sh" });
  assert.equal((await host.wait((l) => l.ref === "sh")).ok, true);
  let seen;
  for (let i = 0; i < 40 && !seen; i++) {
    seen = (await call(client, "wall_read_messages", { since: 0 })).json.messages.find((m) => m.id === secret.id);
    if (!seen) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(seen, "shared entry becomes visible");
  // Tasks and decisions.
  const t1 = await call(client, "wall_add_task", { text: "Envoyer le compte rendu", owner: "me" });
  assert.equal(t1.isError, false, t1.text);
  assert.equal(t1.json.task.owner, me.label);
  const hostTask = await host.wait((l) => l.event === "task" && l.id === t1.json.task.id);
  assert.equal(hostTask.ownerName, "Résumeur");
  const d1 = await call(client, "wall_add_task", { text: "On publie vendredi", kind: "decision" });
  assert.equal(d1.json.task.kind, "decision");
  const up = await call(client, "wall_update_task", { id: t1.json.task.id, done: true });
  assert.equal(up.json.task.done, true);
  host.send({ cmd: "add-task", text: "Tâche réservée aux humains", ref: "ht" });
  await host.wait((l) => l.ref === "ht");
  const list = await call(client, "wall_list_tasks");
  assert.deepEqual(list.json.tasks.map((t) => t.text), ["Envoyer le compte rendu"], "limited view: only its own tasks");
  assert.equal(list.json.decisions.length, 1);
  // Scoped search: limited view finds only what it may see, the search permission widens it.
  const s1 = await call(client, "wall_search", { q: "humains" });
  assert.equal(s1.isError, false, s1.text);
  assert.deepEqual(s1.json.hits, [], "limited view: no hit outside its view");
  host.send({ cmd: "scope", label: me.label, scope: "post,limited,search", ref: "ss" });
  await host.wait((l) => l.ref === "ss");
  await new Promise((r) => setTimeout(r, 200));
  const s2 = await call(client, "wall_search", { q: "humains", k: 3 });
  assert.equal(s2.json.mode, "keyword");
  assert.ok(s2.json.hits.some((h) => h.snippet.includes("humains")), s2.text);
  // Artifact: summary + action items become checklist tasks.
  const art = await call(client, "wall_post_artifact", { kind: "summary", title: "Point du jour", body: "- Décision : publier vendredi", action_items: ["Relire la doc"] });
  assert.equal(art.isError, false, art.text);
  assert.equal(art.json.as, "message");
  assert.equal(art.json.tasks.length, 1);
  const posted = await host.wait((l) => l.event === "message" && l.text?.includes("Point du jour"));
  assert.match(posted.text, /Summary/);
  // Prompt.
  const prompts = await client.listPrompts();
  assert.deepEqual(prompts.prompts.map((p) => p.name), ["summarize_wall"]);
  const pr = await client.getPrompt({ name: "summarize_wall", arguments: { focus: "planning" } });
  assert.match(pr.messages[0].content.text, /wall_post_artifact/);
  assert.match(pr.messages[0].content.text, /model provider/);
  // The host restricts it to read-only: posting is refused.
  host.send({ cmd: "scope", label: me.label, scope: "read-only", ref: "sc" });
  await host.wait((l) => l.ref === "sc");
  let refused;
  for (let i = 0; i < 40; i++) {
    refused = await call(client, "wall_send_message", { text: "encore ?" });
    if (refused.isError) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(refused.isError, true);
  assert.match(refused.text, /permissions/);
  await client.close();
  host.send({ cmd: "leave" });
});
