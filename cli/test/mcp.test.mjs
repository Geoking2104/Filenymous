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
  assert.deepEqual(tools.map((t) => t.name).sort(), ["wall_get_item", "wall_info", "wall_list_participants", "wall_react", "wall_read_messages", "wall_send_file", "wall_send_message"]);

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
