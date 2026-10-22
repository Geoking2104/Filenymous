/**
 * Optional, local A2A (Agent2Agent, https://github.com/a2aproject/A2A, spec 1.0) bridge.
 *
 * Lets an A2A client on this machine delegate tasks to the agents of a Sharewall wall:
 *   SendMessage            → creates a delegated wall task ("submitted") for an assignee
 *   GetTask / ListTasks    → wall task state, note and result mapped to A2A Task / artifacts
 *   CancelTask             → sets the wall task to "canceled"
 *   SendStreamingMessage / SubscribeToTask → SSE stream of status / artifact updates
 *
 * Opt-in (`--a2a`), loopback only, bearer token, no cloud relay. It runs as this CLI's wall
 * participant, so the host tab's approval and scope ("post" needed) apply to everything it does.
 * Push notifications are not supported.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Task as WallTask } from "../../ui/src/wall/collab";
import type { WallAgent } from "./wall";

type J = Record<string, unknown>;
const TERMINAL = new Set(["completed", "failed", "canceled", "rejected"]);
const STATE: Record<string, string> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
  canceled: "TASK_STATE_CANCELED",
  rejected: "TASK_STATE_REJECTED",
};
export const A2A_ERR = { parse: -32700, invalid: -32600, method: -32601, params: -32602, notFound: -32001, notCancelable: -32002, push: -32003, unsupported: -32004, version: -32009 } as const;

class RpcError extends Error {
  constructor(public code: number, msg: string) {
    super(msg);
  }
}

const wallState = (t: WallTask) => t.state ?? (t.done ? "completed" : "working");
const stopped = (t: WallTask) => TERMINAL.has(wallState(t)) || wallState(t) === "input-required";

export function agentCard(url: string, version: string): J {
  return {
    name: "Filenymous Sharewall agents",
    description: "Delegates tasks to the participants (usually AI agents) of an end-to-end encrypted Sharewall wall via a local bridge. Tasks appear on the wall checklist; the assignee reports state, a note and a result.",
    supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    provider: { organization: "Filenymous", url: "https://filenymous.com" },
    version,
    documentationUrl: "https://filenymous.com/docs/sharewall#a2a",
    capabilities: { streaming: true, pushNotifications: false },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer", description: "Token printed once in the CLI's a2a event" } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: "wall-delegate",
        name: "Delegate a task on a Sharewall",
        description: "Creates a task assigned to a wall participant (metadata.owner = label or name; defaults to the only other agent). The task text is at most 500 characters.",
        tags: ["sharewall", "delegation", "tasks"],
        examples: ["Summarise the PDF shared on the wall"],
      },
    ],
  };
}

export async function startA2aBridge(
  agent: WallAgent,
  opts: { port?: number; token?: string; waitMs?: number; version?: string } = {},
) {
  const token = opts.token || process.env.FILENYMOUS_A2A_TOKEN || randomBytes(24).toString("base64url");
  const waitMs = opts.waitMs ?? 600_000;
  const contextId = randomUUID();
  const mine = new Set<string>(); // wall task ids created through this bridge
  const want = Buffer.from(`Bearer ${token}`);
  const authed = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    return got.length === want.length && timingSafeEqual(got, want);
  };
  let base = "";

  const toTask = (t: WallTask, history = false): J => {
    const st = wallState(t);
    const status: J = { state: STATE[st] ?? "TASK_STATE_WORKING", timestamp: new Date(t.editedAt).toISOString() };
    if (t.note) status.message = { messageId: `${t.id}-n${t.v}`, role: "ROLE_AGENT", parts: [{ text: t.note }], taskId: t.id, contextId };
    const out: J = { id: t.id, contextId, status, metadata: { owner: t.owner, ownerName: t.owner ? (agent.participants() as Array<{ label: string; name: string }>).find((m) => m.label === t.owner)?.name ?? null : null } };
    const art = artifact(t);
    if (art) out.artifacts = [art];
    if (history) out.history = [{ messageId: `${t.id}-q`, role: "ROLE_USER", parts: [{ text: t.text }], taskId: t.id, contextId }];
    return out;
  };
  const artifact = (t: WallTask): J | null => {
    if (!t.result) return null;
    const e = agent.entryById(t.result);
    const parts: J[] = [];
    if (e?.text) parts.push({ text: e.text, mediaType: "text/markdown" });
    if (e?.file) parts.push({ data: { wallPostId: e.id, file: e.file, hint: "fetch with `filenymous wall` get / wall_get_file" }, mediaType: "application/json" });
    if (!parts.length) parts.push({ data: { wallPostId: t.result }, mediaType: "application/json" });
    return { artifactId: `${t.id}-${t.result}`, name: e?.file?.name ?? "result", parts };
  };
  const find = (id: unknown): WallTask => {
    const t = typeof id === "string" && mine.has(id) ? agent.getTask(id) : undefined;
    if (!t) throw new RpcError(A2A_ERR.notFound, "task not found");
    return t;
  };
  const until = async (id: string, pred: (t: WallTask) => boolean, ms: number) => {
    const t0 = Date.now();
    for (;;) {
      const t = agent.getTask(id);
      if (!t || pred(t) || Date.now() - t0 > ms) return t;
      await new Promise((ok) => setTimeout(ok, 200));
    }
  };

  const textOf = (msg: J): string => {
    const parts = Array.isArray(msg.parts) ? (msg.parts as J[]) : [];
    if (!parts.length) throw new RpcError(A2A_ERR.params, "message.parts is required");
    if (parts.some((p) => typeof p.text !== "string")) throw new RpcError(A2A_ERR.unsupported, "only text parts are supported (share files on the wall instead)");
    return parts.map((p) => p.text as string).join("\n").trim();
  };
  const pickOwner = (meta: J | undefined): string => {
    const o = meta?.owner ?? meta?.["filenymous/owner"];
    if (typeof o === "string" && o) return o;
    const others = (agent.participants() as Array<{ label: string; agent: boolean; self?: boolean }>).filter((m) => m.agent && m.label !== agent.selfLabel);
    if (others.length === 1) return others[0]!.label;
    throw new RpcError(A2A_ERR.params, "set message.metadata.owner to a participant label or name (several or no agents on the wall)");
  };

  /** Creates (or follows up on) a task; returns its wall id. */
  const send = async (p: J): Promise<{ id: string; blocking: boolean }> => {
    const msg = p.message as J | undefined;
    if (!msg || typeof msg !== "object") throw new RpcError(A2A_ERR.params, "message is required");
    const text = textOf(msg);
    if (!text) throw new RpcError(A2A_ERR.params, "empty message");
    const blocking = !(p.configuration as J | undefined)?.returnImmediately;
    if (msg.taskId !== undefined) {
      const t = find(msg.taskId);
      if (TERMINAL.has(wallState(t))) throw new RpcError(A2A_ERR.unsupported, "task is in a terminal state");
      await agent.send(`↪ ${t.text.slice(0, 80)}: ${text}`);
      if (wallState(t) === "input-required") await agent.updateTask(t.id, { state: "working" });
      return { id: t.id, blocking };
    }
    if (text.length > 500) throw new RpcError(A2A_ERR.params, "task text is limited to 500 characters (post long context on the wall first)");
    let r;
    try {
      r = await agent.delegate(text, pickOwner(msg.metadata as J | undefined));
    } catch (e) {
      throw new RpcError(A2A_ERR.params, (e as Error).message);
    }
    const id = (r.task as { id: string }).id;
    mine.add(id);
    return { id, blocking };
  };

  const rpc = async (method: string, p: J): Promise<unknown> => {
    switch (method) {
      case "SendMessage": {
        const { id, blocking } = await send(p);
        const t = blocking ? await until(id, stopped, waitMs) : agent.getTask(id);
        if (!t) throw new RpcError(A2A_ERR.notFound, "task disappeared from the wall");
        return { task: toTask(t, true) };
      }
      case "GetTask":
        return toTask(find(p.id), true);
      case "ListTasks": {
        const size = Math.max(1, Math.min(Number(p.pageSize ?? 50) || 50, 100));
        const all = agent.allTasks().filter((t) => mine.has(t.id)).sort((a, b) => b.editedAt - a.editedAt);
        const want = typeof p.status === "string" ? p.status : undefined;
        const hit = all.filter((t) => !want || STATE[wallState(t)] === want);
        const start = Number(p.pageToken ?? 0) || 0;
        const page = hit.slice(start, start + size);
        return { tasks: page.map((t) => toTask(t)), nextPageToken: start + size < hit.length ? String(start + size) : "", pageSize: page.length, totalSize: hit.length };
      }
      case "CancelTask": {
        const t = find(p.id);
        if (TERMINAL.has(wallState(t))) throw new RpcError(A2A_ERR.notCancelable, "task is already in a terminal state");
        await agent.updateTask(t.id, { state: "canceled" });
        return toTask((await until(t.id, (x) => wallState(x) === "canceled", 8000)) ?? t);
      }
      case "CreateTaskPushNotificationConfig":
      case "GetTaskPushNotificationConfig":
      case "ListTaskPushNotificationConfigs":
      case "DeleteTaskPushNotificationConfig":
        throw new RpcError(A2A_ERR.push, "push notifications are not supported");
      case "GetExtendedAgentCard":
        throw new RpcError(A2A_ERR.unsupported, "no extended agent card");
      default:
        throw new RpcError(A2A_ERR.method, `method not found: ${method}`);
    }
  };

  const stream = (res: ServerResponse, rid: unknown, id: string) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const emit = (result: unknown) => res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rid, result })}\n\n`);
    let last = "";
    let sentArt = "";
    let closed = false;
    res.on("close", () => (closed = true));
    const tick = () => {
      if (closed) return;
      const t = agent.getTask(id);
      if (!t) {
        emit({ statusUpdate: { taskId: id, contextId, status: { state: "TASK_STATE_FAILED", timestamp: new Date().toISOString() } } });
        return res.end();
      }
      const a = artifact(t);
      if (a && a.artifactId !== sentArt) {
        sentArt = a.artifactId as string;
        emit({ artifactUpdate: { taskId: id, contextId, artifact: a, append: false, lastChunk: true } });
      }
      const key = `${wallState(t)}|${t.note ?? ""}`;
      if (key !== last) {
        if (!last) emit({ task: toTask(t, true) });
        else emit({ statusUpdate: { taskId: id, contextId, status: (toTask(t).status as J) } });
        last = key;
      }
      if (stopped(t)) return res.end();
      setTimeout(tick, 250);
    };
    tick();
  };

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "A2A-Version": "1.0" });
    res.end(JSON.stringify(body));
  };
  const err = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  const server = createServer(async (req, res) => {
    // DNS-rebinding and browser guards: loopback Host only, no cross-origin browser calls.
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host) || req.headers.origin) return json(res, 403, { error: "forbidden" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // The card holds no secret (no wall link, key or member names), so discovery needs no token.
    if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") return json(res, 200, agentCard(`${base}/a2a`, opts.version ?? "0"));
    if (!authed(req)) return json(res, 401, { error: "missing or bad bearer token" });
    if (req.method !== "POST" || url.pathname !== "/a2a") return json(res, 404, { error: "not found" });
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 256 * 1024) return json(res, 413, { error: "too large" });
    }
    let m: J;
    try {
      m = JSON.parse(body);
    } catch {
      return json(res, 200, err(null, A2A_ERR.parse, "parse error"));
    }
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return json(res, 200, err(m?.id, A2A_ERR.invalid, "invalid request"));
    const ver = String(req.headers["a2a-version"] ?? url.searchParams.get("A2A-Version") ?? "").trim() || "0.3";
    if (!/^1\.\d+$/.test(ver)) return json(res, 200, err(m.id, A2A_ERR.version, `A2A version ${ver} not supported (use A2A-Version: 1.0)`));
    const p = (m.params && typeof m.params === "object" ? m.params : {}) as J;
    try {
      if (m.method === "SendStreamingMessage") return stream(res, m.id, (await send(p)).id);
      if (m.method === "SubscribeToTask") {
        const t = find(p.id);
        if (TERMINAL.has(wallState(t))) throw new RpcError(A2A_ERR.unsupported, "task is in a terminal state");
        return stream(res, m.id, t.id);
      }
      return json(res, 200, { jsonrpc: "2.0", id: m.id, result: await rpc(m.method, p) });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : -32603;
      return json(res, 200, err(m.id, code, (e as Error).message || "internal error"));
    }
  });
  await new Promise<void>((ok) => server.listen(opts.port ?? 0, "127.0.0.1", ok));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  base = `http://127.0.0.1:${port}`;
  return { url: base, card: `${base}/.well-known/agent-card.json`, endpoint: `${base}/a2a`, token, close: () => server.close() };
}
