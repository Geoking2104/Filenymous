/** Agent-to-agent tasks on a wall + the opt-in local A2A 1.0 bridge (`--a2a`). */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startRelay } from "./helpers.mjs";
import { killAll, wallCli } from "./wall-helpers.mjs";

let relay;
before(async () => (relay = await startRelay()));
after(() => (killAll(), relay?.stop()));
const common = () => ["--signal", relay.url, "--app-url", "http://localhost:5173/", "--quiet"];

test("A2A bridge: card, version check, delegate → worker reports → artifact; cancel; stream", { timeout: 90_000 }, async () => {
  const host = wallCli(["create", "--allow-agents", ...common()]);
  const ready = await host.wait((l) => l.event === "ready");
  const worker = wallCli(["join", ready.link, "--name", "Worker", ...common()]);
  const wr = await worker.wait((l) => l.event === "ready");
  const boss = wallCli(["join", ready.link, "--a2a", "--name", "Boss", ...common()]);
  await boss.wait((l) => l.event === "ready");
  const a2a = await boss.wait((l) => l.event === "a2a");
  assert.match(a2a.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/a2a$/);

  const card = await (await fetch(a2a.card)).json();
  assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
  assert.equal(card.supportedInterfaces[0].url, a2a.endpoint);
  assert.equal(card.capabilities.streaming, true);
  assert.ok(!JSON.stringify(card).includes("#wall:"), "card must not leak the wall link");
  assert.equal((await fetch(a2a.card, { headers: { origin: "https://evil.example" } })).status, 403);

  const rpc = async (method, params, version = "1.0", id = 1) => {
    const headers = { authorization: `Bearer ${a2a.token}`, "content-type": "application/json", ...(version ? { "A2A-Version": version } : {}) };
    return (await fetch(a2a.endpoint, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json();
  };
  assert.equal((await fetch(a2a.endpoint, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await rpc("GetTask", { id: "x" }, "")).error.code, -32009);
  assert.equal((await rpc("GetTask", { id: "t-0000000000000000" })).error.code, -32001);
  assert.equal((await rpc("CreateTaskPushNotificationConfig", {})).error.code, -32003);

  const msg = (text, extra = {}) => ({ message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], metadata: { owner: "Worker" }, ...extra }, configuration: { returnImmediately: true } });
  const sent = await rpc("SendMessage", msg("Résume le document"));
  const task = sent.result.task;
  assert.equal(task.status.state, "TASK_STATE_SUBMITTED");
  assert.equal(task.metadata.owner, wr.label);

  // The worker sees it on the checklist, assigned to it, and reports progress.
  const seen = await worker.wait((l) => l.event === "task" && l.id === task.id && l.state === "submitted");
  assert.equal(seen.mine, true);
  worker.send({ cmd: "update-task", id: task.id, state: "working", note: "je lis" });
  await host.wait((l) => l.event === "task" && l.id === task.id && l.state === "working" && l.note === "je lis");
  assert.equal((await rpc("GetTask", { id: task.id })).result.status.state, "TASK_STATE_WORKING");
  worker.send({ cmd: "send", text: "Résumé : tout va bien." });
  const post = await host.wait((l) => l.event === "message" && l.text === "Résumé : tout va bien.");
  worker.send({ cmd: "update-task", id: task.id, state: "completed", result: post.id });
  await boss.wait((l) => l.event === "task" && l.id === task.id && l.state === "completed");
  const done = (await rpc("GetTask", { id: task.id })).result;
  assert.equal(done.status.state, "TASK_STATE_COMPLETED");
  assert.equal(done.artifacts[0].parts[0].text, "Résumé : tout va bien.");
  assert.equal((await rpc("CancelTask", { id: task.id })).error.code, -32002);

  const t2 = (await rpc("SendMessage", msg("Deuxième tâche"))).result.task;
  const can = (await rpc("CancelTask", { id: t2.id })).result;
  assert.equal(can.status.state, "TASK_STATE_CANCELED");
  const list = (await rpc("ListTasks", {})).result;
  assert.equal(list.totalSize, 2);

  // Streaming: status updates until a terminal state.
  const res = await fetch(a2a.endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${a2a.token}`, "content-type": "application/json", "A2A-Version": "1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "SendStreamingMessage", params: { message: { messageId: "m3", role: "ROLE_USER", parts: [{ text: "Troisième" }], metadata: { owner: wr.label } } } }),
  });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body.getReader();
  let sse = "";
  const first = await reader.read();
  sse += new TextDecoder().decode(first.value);
  const id3 = JSON.parse(sse.split("\n").find((l) => l.startsWith("data: ")).slice(6)).result.task.id;
  worker.send({ cmd: "update-task", id: id3, state: "failed", note: "pas de fichier" });
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    sse += new TextDecoder().decode(value);
  }
  assert.match(sse, /TASK_STATE_FAILED/);
  assert.match(sse, /pas de fichier/);

  // State changes by someone who is neither author, owner nor host are refused.
  const t4 = (await rpc("SendMessage", msg("Quatrième"))).result.task;
  const other = wallCli(["join", ready.link, "--name", "Other", ...common()]);
  await other.wait((l) => l.event === "ready");
  for (let i = 0; i < 100 && !other.lines.some((l) => Array.isArray(l.tasks) && l.tasks.some((t) => t.id === t4.id)); i++) {
    other.send({ cmd: "tasks" });
    await new Promise((r) => setTimeout(r, 100));
  }
  other.send({ cmd: "update-task", id: t4.id, state: "completed" });
  await other.wait((l) => l.ok === false || l.error);
  assert.equal((await rpc("GetTask", { id: t4.id })).result.status.state, "TASK_STATE_SUBMITTED");

  host.send({ cmd: "leave" });
  await host.exited;
});
