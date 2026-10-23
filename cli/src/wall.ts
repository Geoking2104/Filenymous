/**
 * Sharewall for agents and scripts: `filenymous wall create|join|mcp`.
 *
 * Runs the web app's own wall engines (ui/src/wall) in Node through the
 * browser shims (node-datachannel, ws). The agent is a normal participant of
 * the star (one sealed DataChannel to the host) that declares itself as an AI
 * agent ("IA"/"AI" badge, self-declared). It never downloads anything on its
 * own: files and masked notes are only fetched on an explicit `get`.
 *
 * Interfaces (all on top of WallAgent):
 *   - JSON Lines on stdin/stdout (default)
 *   - optional local HTTP + SSE bridge (127.0.0.1 only, random bearer token)
 *   - MCP server over stdio (`wall mcp`)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WallHost } from "../../ui/src/wall/host";
import { ENDED, WallPeer } from "../../ui/src/wall/peer";
import { buildWallLink, createWall, parseWallLink, wallCode, type HostWallParams, type WallParams, type WallTtl } from "../../ui/src/wall/link";
import { cleanName, pseudonym, type Member, type Post, type WallEvent } from "../../ui/src/wall/feed";
import { safeFileName } from "../../ui/src/p2p/protocol";
import { AGENT_TASK_STATES, SCOPE_FULL, TASK_NOTE_MAX, cleanTaskText, isAgentTaskState, isResultId, isTaskId, parseScopeArg, scopeName, type AgentScope, type Task, type TaskKind, type TaskPatch } from "../../ui/src/wall/collab";
import { NOTE_MAX_BYTES, cleanNoteText, cleanNoteTitle, isNoteId, utf8Bytes, type SharedNote } from "../../ui/src/wall/notes";

declare const __VERSION__: string;

export interface WallCliOptions {
  name?: string;
  password?: string;
  signalUrl?: string;
  appUrl: string;
  ttl?: string;
  /** Wall display name (wall create), shown to every participant. */
  title?: string;
  burn?: boolean;
  keepOnLeave?: boolean;
  allowAgents?: boolean;
  /** wall create: scope given to agents that join (they are admitted without asking). */
  agentScope?: string;
  filesRoot?: string;
  output?: string;
  quiet?: boolean;
}

const log = (quiet: boolean | undefined, s: string) => !quiet && process.stderr.write(`${s}\n`);
const MAX_LOG = 2000;
const TEXT_INLINE_MAX = 64 * 1024;

/**
 * Walls have no lifetime by default (they live as long as their host). `--ttl`
 * is still accepted for a wall that must also end at a fixed time.
 */
export function wallTtl(raw: string | undefined): WallTtl | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (["15m", "m15", "15min"].includes(v)) return "m15";
  if (["1h", "h1", "60m"].includes(v)) return "h1";
  if (["24h", "h24", "1d"].includes(v)) return "h24";
  throw new Error(`--ttl for a wall must be 15m, 1h or 24h (got ${raw})`);
}

/** A feed entry as agents see it (stable, JSON-friendly). */
export interface Entry {
  seq: number;
  id: string;
  type: "message" | "file" | "note" | "poll";
  by: string;
  name: string;
  agent: boolean;
  self: boolean;
  at: string;
  text?: string;
  replyTo?: string;
  mentions?: string[];
  mentionsMe?: boolean;
  file?: { name: string; size: number; mime: string };
  poll?: { question: string; options: Array<{ text: string; votes: number }>; closed: boolean };
  reactions?: Record<string, number>;
}

type Out = Record<string, unknown>;

export class WallAgent {
  private host: WallHost | null = null;
  private peer: WallPeer | null = null;
  private posts = new Map<string, Post>();
  private members: Member[] = [];
  private names = new Map<string, string>();
  private seqOf = new Map<string, number>();
  private seq = 0;
  private liveCount = 0;
  private log: Entry[] = [];
  private listeners = new Set<(e: Out) => void>();
  private waiters = new Set<() => void>();
  private readyResolve!: (v: Out) => void;
  private readyReject!: (e: Error) => void;
  readonly ready: Promise<Out>;
  link?: string;
  code = "";
  endedReason?: string;
  params!: WallParams;

  constructor(readonly opts: WallCliOptions) {
    this.ready = new Promise((ok, ko) => {
      this.readyResolve = ok;
      this.readyReject = ko;
    });
    this.ready.catch(() => undefined);
  }

  get role(): "host" | "peer" {
    return this.host ? "host" : "peer";
  }

  get self(): string | undefined {
    return this.host ? "host" : this.peer?.label;
  }

  on(fn: (e: Out) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: Out) {
    for (const fn of this.listeners) fn(e);
  }

  private nameOf(label: string): string {
    return this.members.find((m) => m.label === label)?.name ?? this.names.get(label) ?? label;
  }

  private isAgent(label: string): boolean {
    return !!this.members.find((m) => m.label === label)?.agent;
  }

  private entry(p: Post): Entry {
    let seq = this.seqOf.get(p.id);
    if (seq === undefined) {
      seq = ++this.seq;
      this.seqOf.set(p.id, seq);
    }
    const self = p.by === this.self;
    const e: Entry = {
      seq,
      id: p.id,
      type: p.kind === "msg" ? "message" : p.kind,
      by: p.by,
      name: this.nameOf(p.by),
      agent: this.isAgent(p.by),
      self,
      at: new Date(p.at).toISOString(),
    };
    if (p.text) e.text = p.text;
    if (p.replyTo) e.replyTo = p.replyTo;
    if (p.mentions?.length) {
      e.mentions = p.mentions;
      e.mentionsMe = !!this.self && p.mentions.includes(this.self);
    }
    if (p.item) e.file = { name: p.item.name || (p.kind === "note" ? "note" : "file"), size: p.item.size, mime: p.item.mime };
    if (p.poll) e.poll = { question: p.poll.question, options: p.poll.options.map((text, i) => ({ text, votes: p.poll!.votes[i]?.length ?? 0 })), closed: p.poll.closed };
    const r = Object.entries(p.reactions);
    if (r.length) e.reactions = Object.fromEntries(r.map(([k, v]) => [k, v.length]));
    return e;
  }

  private onEvent = (ev: WallEvent) => {
    switch (ev.type) {
      case "post": {
        const prev = this.posts.get(ev.post.id);
        this.posts.set(ev.post.id, ev.post);
        if (!prev) {
          const e = this.entry(ev.post);
          this.log.push(e);
          if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
          this.emit({ event: e.type, ...e });
          for (const w of this.waiters) w();
        } else {
          // Reactions and votes arrive as post updates: report the difference.
          const keys = new Set([...Object.keys(prev.reactions), ...Object.keys(ev.post.reactions)]);
          for (const emoji of keys) {
            const a = prev.reactions[emoji] ?? [];
            const b = ev.post.reactions[emoji] ?? [];
            for (const by of b.filter((l) => !a.includes(l))) this.emit({ event: "reaction", id: ev.post.id, emoji, by, name: this.nameOf(by), self: by === this.self, added: true, count: b.length });
            for (const by of a.filter((l) => !b.includes(l))) this.emit({ event: "reaction", id: ev.post.id, emoji, by, name: this.nameOf(by), self: by === this.self, added: false, count: b.length });
          }
          if (ev.post.poll && JSON.stringify(prev.poll) !== JSON.stringify(ev.post.poll)) this.emit({ event: "poll.update", ...this.entry(ev.post) });
        }
        return;
      }
      case "unpost":
        this.posts.delete(ev.id);
        this.emit({ event: "removed", id: ev.id });
        return;
      case "join":
      case "leave":
        this.names.set(ev.member.label, ev.member.name);
        this.emit({ event: ev.type, label: ev.member.label, name: ev.member.name, agent: ev.member.agent, host: ev.member.host, self: ev.member.label === this.self });
        return;
      case "members": {
        this.members = ev.members;
        for (const m of ev.members) this.names.set(m.label, m.name);
        const mine = this.self ? ev.members.find((m) => m.label === this.self)?.scope : undefined;
        const key = mine ? JSON.stringify(mine) : "";
        if (mine && key !== this.lastScope) {
          this.lastScope = key;
          this.emit({ event: "scope", scope: this.scopeOut(mine) });
        }
        return;
      }
      case "pin":
        this.emit({ event: "pin", id: ev.id });
        return;
      case "live":
        if (!ev.streams.length && !this.liveCount) return;
        this.liveCount = ev.streams.length;
        this.emit({ event: "live", streams: ev.streams.map((s) => ({ ...s, name: this.nameOf(s.by) })), note: "live audio/video is not available to CLI agents" });
        return;
      case "note":
        this.emit({ event: "note", ...this.noteOut(ev.note, false), ...(ev.overwrote ? { overwrote: ev.overwrote, overwroteMe: ev.overwrote === this.self } : {}) });
        for (const w of this.waiters) w();
        return;
      case "note-gone":
        this.emit({ event: "note.removed", id: ev.id });
        for (const w of this.waiters) w();
        return;
      case "notice":
        this.emit({ event: "notice", code: ev.code, ...(ev.code === "scope-denied" ? { hint: "your permissions on this wall (set by the host) don't allow this action; see wall_info.scope" } : {}), ...(ev.retryMs !== undefined ? { retryMs: ev.retryMs } : {}) });
        return;
      case "task":
        this.emit({ event: "task", ...this.taskOut(ev.task) });
        for (const w of this.waiters) w();
        return;
      case "task-gone":
        this.emit({ event: "task.removed", id: ev.id });
        return;
      default:
        return;
    }
  };

  private lastScope = "";
  private pendingSeen = false;

  /** This agent's permissions as set by the host (undefined when hosting, or when an older host doesn't send scopes). */
  get scope(): AgentScope | undefined {
    if (this.host) return undefined;
    return this.members.find((m) => m.label === this.self)?.scope;
  }

  private scopeOut(s: AgentScope | undefined): Out | null {
    if (!s) return null;
    return { name: scopeName(s), post: s.post, files: s.files, secrets: s.secrets, limitedView: s.limited };
  }

  /** Refuses locally what the host would refuse anyway (clearer errors for the agent). */
  private needScope(need: "post" | "files" | "secrets") {
    const s = this.scope;
    if (s && !s[need]) throw new Error(`refused: your permissions on this wall don't allow ${need === "post" ? "posting" : need === "files" ? "fetching files" : "revealing secrets"} (set by the host; see wall_info.scope)`);
  }

  private end(reason: string) {
    if (this.endedReason) return;
    this.endedReason = reason;
    this.emit({ event: "ended", reason });
    for (const w of this.waiters) w();
    this.readyReject(new Error(reason));
  }

  /** Hosts a new wall (the agent's process holds it in memory). */
  async create(): Promise<Out> {
    if (this.opts.agentScope && !parseScopeArg(this.opts.agentScope)) throw new Error("--agent-scope: read-only | post | full | comma list of post,files,secrets,limited,search");
    const name = cleanName(this.opts.name) || `Agent ${pseudonym("en")}`;
    const params: HostWallParams = await createWall({ ttl: wallTtl(this.opts.ttl), title: this.opts.title, password: !!this.opts.password, burn: !!this.opts.burn, hostLeave: !this.opts.keepOnLeave });
    this.params = params;
    this.link = buildWallLink(this.opts.appUrl, params);
    this.code = await wallCode(params);
    const host = new WallHost(
      params,
      (st) => {
        debug("host", st.status, st.members.length);
        this.relayError(st.error);
        if (st.status === "online" && !this.ready_) this.markReady();
        if (st.status === "destroyed" || st.status === "expired") this.end(st.status);
        if (st.status === "error") this.readyReject(new Error(st.error ?? "error"));
      },
      {
        signalUrl: this.opts.signalUrl,
        password: this.opts.password,
        name,
        agent: true,
        media: false,
        allowAgents: !!this.opts.allowAgents,
        // No human tab to approve: agents are admitted with the scope given on the command line.
        autoApproveAgents: true,
        agentScope: this.opts.agentScope ? (parseScopeArg(this.opts.agentScope) ?? SCOPE_FULL) : SCOPE_FULL,
      },
    );
    this.host = host;
    this.members = host.state.members;
    host.on(this.onEvent);
    void host.start();
    return this.ready;
  }

  /** Joins a wall with its invite link. */
  async join(link: string): Promise<Out> {
    const params = parseWallLink(link);
    if (!params) throw new Error("not a Sharewall invite link (…#wall:wall-…/key/exp/flags)");
    if (params.password && !this.opts.password) throw new Error("this wall needs a password (--password or FILENYMOUS_PASSWORD)");
    this.params = params;
    this.code = await wallCode(params);
    const name = cleanName(this.opts.name) || `Agent ${pseudonym("en")}`;
    const peer = new WallPeer(
      params,
      (st) => {
        debug("peer", st.status);
        this.relayError(st.error);
        if (st.status === "online" && st.pending && !this.pendingSeen) {
          this.pendingSeen = true;
          this.emit({ event: "pending", note: "waiting for the host to approve this agent; nothing of the wall is visible until then" });
        }
        if (st.status === "online" && !st.pending && this.pendingSeen) {
          this.pendingSeen = false;
          this.emit({ event: "approved", scope: this.scopeOut(this.scope) });
        }
        // Ready once the host has listed us (so wall_info already reports our scope).
        if (st.status === "online" && !st.pending && !this.ready_ && st.members.some((m) => m.label === st.label)) this.markReady();
        else if (st.status === "bad-password") this.fail("bad-password");
        else if (st.status === "full") this.fail("wall-full");
        else if (st.status === "error" && !this.ready_) this.fail(st.error ?? "error");
        if (ENDED.includes(st.status)) this.end(st.status);
      },
      { signalUrl: this.opts.signalUrl, name, agent: true, media: false },
    );
    this.peer = peer;
    peer.on(this.onEvent);
    void peer.start(this.opts.password);
    return this.ready;
  }

  private lastRelayError?: string;
  /** Relay-side problems (e.g. its per-IP rate limit) as notices, once each. */
  private relayError(error?: string) {
    if (error === this.lastRelayError) return;
    this.lastRelayError = error;
    if (!error) return;
    debug("relay error", error);
    this.emit({ event: "notice", code: error === "rate-limited" ? "relay-rate-limited" : `relay-${error}` });
  }

  private ready_ = false;
  private markReady() {
    this.ready_ = true;
    this.readyResolve(this.info());
  }

  private fail(reason: string) {
    this.readyReject(new Error(reason));
    this.end(reason);
    this.peer?.stop();
  }

  info(): Out {
    return {
      role: this.role,
      label: this.self,
      code: this.code,
      expiresAt: this.params.expiresAt ? new Date(this.params.expiresAt).toISOString() : null,
      title: (this.host ? (this.params as HostWallParams).title : this.peer?.state.title) || "",
      burn: this.params.burn,
      destroyOnHostLeave: this.params.hostLeave,
      password: this.params.password,
      agentsAllowed: this.host ? this.host.state.agents : this.peer?.state.agents,
      ...(this.host ? { agentScope: this.scopeOut(this.opts.agentScope ? (parseScopeArg(this.opts.agentScope) ?? SCOPE_FULL) : SCOPE_FULL) } : { scope: this.scopeOut(this.scope) }),
      ...(this.link ? { link: this.link } : {}),
    };
  }

  participants(): Array<Out> {
    return this.members.map((m) => ({ label: m.label, name: m.name, agent: m.agent, host: m.host, handRaised: m.hand, self: m.label === this.self, ...(m.scope ? { scope: this.scopeOut(m.scope) } : {}) }));
  }

  /** Feed entries after `since` (seq), oldest first; reactions/poll counts are current. */
  read(since = 0, limit = 50): { messages: Entry[]; next: number } {
    const out = this.log.filter((e) => e.seq > since && this.posts.has(e.id)).slice(0, Math.max(1, Math.min(limit, 200)));
    const fresh = out.map((e) => this.entry(this.posts.get(e.id)!));
    return { messages: fresh, next: fresh.length ? fresh[fresh.length - 1]!.seq : since };
  }

  /** One feed entry by post id (for the A2A bridge's artifacts). */
  entryById(id: string): Entry | undefined {
    const p = this.posts.get(id);
    return p ? this.entry(p) : undefined;
  }

  /** Waits until an entry newer than `since` exists (or the timeout/end). */
  waitFor(since: number, ms: number): Promise<void> {
    if (this.log.some((e) => e.seq > since) || this.endedReason) return Promise.resolve();
    return new Promise((ok) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        ok();
      };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  private alive() {
    if (this.endedReason) throw new Error(`wall ended (${this.endedReason})`);
  }

  async send(text: string, replyTo?: string): Promise<Out> {
    this.alive();
    this.needScope("post");
    if (typeof text !== "string" || !text.trim()) throw new Error("text is required");
    if (this.host) this.host.say(text, replyTo);
    else await this.peer!.say(text, replyTo);
    return { ok: true };
  }

  async react(id: string, emoji: string): Promise<Out> {
    this.alive();
    this.needScope("post");
    if (!this.posts.has(id)) throw new Error(`unknown message id: ${id}`);
    if (this.host) this.host.react(id, emoji);
    else await this.peer!.react(id, emoji);
    return { ok: true };
  }

  async vote(id: string, option: number): Promise<Out> {
    this.alive();
    this.needScope("post");
    if (this.host) this.host.vote(id, option);
    else await this.peer!.vote(id, option);
    return { ok: true };
  }

  async poll(question: string, options: string[]): Promise<Out> {
    this.alive();
    this.needScope("post");
    if (this.host) this.host.createPoll(question, options);
    else await this.peer!.createPoll(question, options);
    return { ok: true };
  }

  private noteList(): SharedNote[] {
    return (this.host ? this.host.state.notes : this.peer?.state.notes) ?? [];
  }

  private noteOut(n: SharedNote, withText = true): Out {
    return {
      id: n.id,
      title: n.title,
      ...(withText ? { text: n.text } : { size: utf8Bytes(n.text) }),
      version: n.v,
      by: n.by,
      name: this.nameOf(n.by),
      editedBy: n.editedBy,
      editedByName: this.nameOf(n.editedBy),
      editedAt: new Date(n.editedAt).toISOString(),
      pinned: n.pinned,
      self: n.editedBy === this.self,
    };
  }

  /** Shared notes, pinned first (full text). */
  notes(id?: string): Out {
    const all = this.noteList();
    if (id !== undefined) {
      const n = all.find((x) => x.id === id);
      if (!n) throw new Error(`unknown note id: ${id}`);
      return { ok: true, note: this.noteOut(n) };
    }
    return { ok: true, notes: all.map((n) => this.noteOut(n)) };
  }

  private async untilNote(pred: (n: SharedNote[]) => SharedNote | undefined, ms = 8000): Promise<SharedNote | undefined> {
    const t0 = Date.now();
    for (;;) {
      const hit = pred(this.noteList());
      if (hit || Date.now() - t0 > ms || this.endedReason) return hit;
      await new Promise((ok) => setTimeout(ok, 50));
    }
  }

  /**
   * Creates a shared note (no id) or replaces one (last writer wins, host
   * ordering). Resolves once the host has applied it.
   */
  async writeNote(o: { id?: string; title?: string; text?: string }): Promise<Out> {
    this.alive();
    this.needScope("post");
    const text = o.text === undefined ? undefined : cleanNoteText(o.text);
    const title = o.title === undefined ? undefined : cleanNoteTitle(o.title);
    if (text === null) throw new Error(`note text too long (max ${NOTE_MAX_BYTES} bytes)`);
    if (title === null) throw new Error("note title too long");
    if (!o.id) {
      const before = new Set(this.noteList().map((n) => n.id));
      if (this.host) this.host.createNote(title ?? "", text ?? "");
      else await this.peer!.createNote(title ?? "", text ?? "");
      const n = await this.untilNote((l) => l.find((x) => !before.has(x.id) && x.by === this.self));
      if (!n) throw new Error("the host did not accept the note (limit reached or rate-limited)");
      return { ok: true, note: this.noteOut(n) };
    }
    if (!isNoteId(o.id)) throw new Error(`invalid note id: ${o.id}`);
    const cur = this.noteList().find((x) => x.id === o.id);
    if (!cur) throw new Error(`unknown note id: ${o.id}`);
    if (text === undefined && title === undefined) throw new Error("text or title is required");
    const patch = { ...(title !== undefined ? { title } : {}), ...(text !== undefined ? { text } : {}) };
    if (this.host) this.host.editNote(cur.id, cur.v, patch);
    else await this.peer!.editNote(cur.id, cur.v, patch);
    const n = await this.untilNote((l) => l.find((x) => x.id === cur.id && x.v > cur.v && x.editedBy === this.self));
    if (!n) throw new Error("the host did not apply the edit (rate-limited?)");
    return { ok: true, note: this.noteOut(n) };
  }

  async deleteNote(id: string): Promise<Out> {
    this.alive();
    this.needScope("post");
    if (!this.noteList().some((x) => x.id === id)) throw new Error(`unknown note id: ${id}`);
    if (this.host) this.host.deleteNote(id);
    else await this.peer!.deleteNote(id);
    const still = await this.untilNote((l) => (l.some((x) => x.id === id) ? undefined : ({} as SharedNote)), 5000);
    if (!still) throw new Error("not deleted (only the note's author or the host can delete it)");
    return { ok: true };
  }

  async note(text: string): Promise<Out> {
    this.alive();
    this.needScope("post");
    const r = this.host ? this.host.addText(text) : this.peer!.addText(text);
    if (typeof r === "string") throw new Error(r);
    if (r) await r;
    return { ok: true };
  }

  /** Resolves a path inside the allowed root (default: current directory), symlinks included. */
  private safePath(p: string): string {
    const root = realpathSync(resolve(this.opts.filesRoot ?? "."));
    const full = realpathSync(resolve(root, p));
    const rel = relative(root, full);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) throw new Error(`refused: ${p} is outside the allowed directory (${root}); see --files-root`);
    if (!statSync(full).isFile()) throw new Error(`not a file: ${p}`);
    return full;
  }

  async file(input: { path?: string; name?: string; content?: string; base64?: boolean; replyTo?: string }): Promise<Out> {
    this.alive();
    this.needScope("post");
    let name: string;
    let data: Blob;
    if (input.path) {
      const full = this.safePath(input.path);
      name = basename(full);
      data = new Blob([readFileSync(full)]);
    } else if (input.name && typeof input.content === "string") {
      name = safeFileName(input.name);
      data = new Blob([input.base64 ? Buffer.from(input.content, "base64") : input.content]);
    } else throw new Error("give a path, or a name and content");
    const mime = mimeOf(name);
    const r = this.host ? this.host.addBlob(name, mime, new Blob([data], { type: mime }), input.replyTo) : await this.peer!.addBlob(name, mime, data, input.replyTo);
    if (r) throw new Error(r);
    return { ok: true, name, size: data.size };
  }

  /**
   * Explicitly fetches an item. Text and notes ≤ 64 KiB come back inline;
   * other files are written to the output directory. On a burn wall this
   * consumes the item for everyone else.
   */
  async get(id: string, outDir?: string): Promise<Out> {
    this.alive();
    const post = this.posts.get(id);
    if (!post?.item) throw new Error(`unknown item id: ${id}`);
    let got;
    try {
      got = this.host ? this.host.fetch(id) : await this.peer!.fetch(id);
    } catch (e) {
      if ((e as Error).message === "denied") throw new Error(`refused by the host: your permissions don't allow fetching this ${post.kind === "note" ? "secret" : "file"} (see wall_info.scope; the host can share it with you)`);
      throw e;
    }
    if (!got) throw new Error("gone");
    const isText = got.meta.kind === "text" || /^text\/|json|xml|yaml|csv/.test(got.meta.mime);
    if (isText && got.data.size <= TEXT_INLINE_MAX) return { ok: true, id, name: got.meta.name, text: await got.data.text() };
    const dir = resolve(outDir ?? this.opts.output ?? ".");
    mkdirSync(dir, { recursive: true });
    const path = uniquePath(dir, safeFileName(got.meta.name || "file"));
    writeFileSync(path, new Uint8Array(await got.data.arrayBuffer()));
    return { ok: true, id, name: got.meta.name, path, size: got.data.size };
  }

  // ---- checklist / decisions ----

  private taskList(): Task[] {
    return (this.host ? this.host.state.tasks : this.peer?.state.tasks) ?? [];
  }

  private taskOut(t: Task): Out {
    return {
      id: t.id,
      kind: t.kind,
      text: t.text,
      ...(t.kind === "task" ? { done: t.done, owner: t.owner, ownerName: t.owner ? this.nameOf(t.owner) : null, mine: t.owner === this.self } : {}),
      ...(t.state ? { state: t.state, ...(t.note ? { note: t.note } : {}), ...(t.result ? { result: t.result } : {}) } : {}),
      by: t.by,
      name: this.nameOf(t.by),
      at: new Date(t.at).toISOString(),
      editedBy: t.editedBy,
      editedAt: new Date(t.editedAt).toISOString(),
      self: t.by === this.self,
    };
  }

  tasks(): Out {
    const all = this.taskList();
    return { ok: true, tasks: all.filter((t) => t.kind === "task").map((t) => this.taskOut(t)), decisions: all.filter((t) => t.kind === "decision").map((t) => this.taskOut(t)) };
  }

  private async untilTask(pred: (l: Task[]) => Task | undefined, ms = 8000): Promise<Task | undefined> {
    const t0 = Date.now();
    for (;;) {
      const hit = pred(this.taskList());
      if (hit || Date.now() - t0 > ms || this.endedReason) return hit;
      await new Promise((ok) => setTimeout(ok, 50));
    }
  }

  /** `owner`: a participant label, "me", or omitted. */
  private ownerLabel(owner: string | undefined | null): string | null | undefined {
    if (owner === undefined) return undefined;
    if (owner === null || owner === "") return null;
    if (owner === "me") return this.self ?? null;
    const m = this.members.find((x) => x.label === owner || x.name === owner);
    if (!m) throw new Error(`unknown participant: ${owner} (use a label from wall_list_participants, or "me")`);
    return m.label;
  }

  /** Raw task (for the A2A bridge). */
  getTask(id: string): Task | undefined {
    return this.taskList().find((x) => x.id === id);
  }
  allTasks(): Task[] {
    return this.taskList();
  }
  get selfLabel(): string | undefined {
    return this.self;
  }

  /** Delegates a task to another participant (A2A-style lifecycle: submitted → working → completed/…). */
  delegate(text: string, owner: string): Promise<Out> {
    if (!owner) throw new Error("owner is required (a participant label or name)");
    return this.addTask("task", text, owner, "submitted");
  }

  async addTask(kind: TaskKind, text: string, owner?: string | null, state?: "submitted"): Promise<Out> {
    this.alive();
    this.needScope("post");
    if (kind !== "task" && kind !== "decision") throw new Error('kind must be "task" or "decision"');
    const clean = cleanTaskText(text);
    if (!clean) throw new Error("text is required (max 500 characters)");
    const o = this.ownerLabel(owner) ?? null;
    const before = new Set(this.taskList().map((t) => t.id));
    if (state && kind !== "task") throw new Error("only tasks can be delegated");
    if (this.host) this.host.addTask(kind, clean, o, state);
    else await this.peer!.addTask(kind, clean, o, state);
    const t = await this.untilTask((l) => l.find((x) => !before.has(x.id) && x.by === this.self));
    if (!t) throw new Error("the host did not accept the task (limit reached, rate-limited, or not supported by this host)");
    return { ok: true, task: this.taskOut(t) };
  }

  async updateTask(id: string, patch: { done?: boolean; owner?: string | null; text?: string; state?: string; note?: string; result?: string }): Promise<Out> {
    this.alive();
    this.needScope("post");
    if (!isTaskId(id)) throw new Error(`invalid task id: ${id}`);
    const cur = this.taskList().find((x) => x.id === id);
    if (!cur) throw new Error(`unknown task id: ${id}`);
    const p: TaskPatch = {};
    if (patch.state !== undefined) {
      if (!isAgentTaskState(patch.state)) throw new Error(`state must be one of: ${AGENT_TASK_STATES.join(", ")}`);
      p.state = patch.state;
    }
    if (patch.note !== undefined) p.note = String(patch.note).slice(0, TASK_NOTE_MAX);
    if (patch.result !== undefined) {
      if (!isResultId(patch.result)) throw new Error("result must be a post id from this wall");
      p.result = patch.result;
    }
    if (typeof patch.done === "boolean") p.done = patch.done;
    if (patch.owner !== undefined) p.owner = this.ownerLabel(patch.owner) ?? null;
    if (patch.text !== undefined) {
      const c = cleanTaskText(patch.text);
      if (!c) throw new Error("text is empty or too long");
      p.text = c;
    }
    if (!Object.keys(p).length) throw new Error("give done, owner, text, state, note or result");
    if (this.host) this.host.updateTask(id, p);
    else await this.peer!.updateTask(id, p);
    const t = await this.untilTask((l) => l.find((x) => x.id === id && x.editedBy === this.self && x.editedAt >= cur.editedAt && JSON.stringify(x) !== JSON.stringify(cur)));
    if (!t) throw new Error("the host did not apply the change (only the author or the host can edit the text)");
    return { ok: true, task: this.taskOut(t) };
  }

  async deleteTask(id: string): Promise<Out> {
    this.alive();
    this.needScope("post");
    if (!this.taskList().some((x) => x.id === id)) throw new Error(`unknown task id: ${id}`);
    if (this.host) this.host.deleteTask(id);
    else await this.peer!.deleteTask(id);
    const gone = await this.untilTask((l) => (l.some((x) => x.id === id) ? undefined : ({} as Task)), 5000);
    if (!gone) throw new Error("not deleted (only the author or the host can delete it)");
    return { ok: true };
  }

  /**
   * Posts a structured artifact (summary, action items, report…): a chat
   * message when it fits, otherwise a Markdown file; `actionItems` also become
   * checklist tasks (owner optional).
   */
  async postArtifact(a: { kind?: string; title?: string; body?: string; actionItems?: Array<string | { text: string; owner?: string }> }): Promise<Out> {
    this.alive();
    this.needScope("post");
    const kinds: Record<string, string> = { summary: "📝 Summary", "action-items": "✅ Action items", report: "📄 Report", decisions: "🧭 Decisions", answer: "💬 Answer" };
    const kind = a.kind && kinds[a.kind] ? a.kind : "report";
    const title = (a.title ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
    const body = (a.body ?? "").trim();
    const items = (a.actionItems ?? []).map((x) => (typeof x === "string" ? { text: x } : x)).filter((x) => x && typeof x.text === "string" && x.text.trim()).slice(0, 30);
    if (!body && !items.length) throw new Error("body or actionItems is required");
    const NL = "\n";
    const head = `**${kinds[kind]}${title ? ` — ${title}` : ""}**`;
    const list = items.length ? NL + NL + items.map((x) => `- [ ] ${x.text.trim()}`).join(NL) : "";
    const text = (head + NL + NL + body + list).trim();
    let posted: Out;
    if (text.length <= 3800) {
      await this.send(text);
      posted = { as: "message" };
    } else {
      const name = `${(title || kind).replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "-").slice(0, 60) || kind}.md`;
      await this.file({ name, content: `# ${kinds[kind]}${title ? ` — ${title}` : ""}` + NL + NL + body + list + NL });
      await this.send(head + NL + NL + body.slice(0, 600) + (body.length > 600 ? "…" : "") + NL + NL + `📎 ${name}`);
      posted = { as: "file", name };
    }
    const tasks: Out[] = [];
    for (const it of items) {
      try {
        tasks.push((await this.addTask("task", it.text, it.owner)).task as Out);
      } catch (e) {
        tasks.push({ error: String((e as Error).message || e), text: it.text });
      }
    }
    return { ok: true, ...posted, ...(tasks.length ? { tasks } : {}) };
  }

  /**
   * Scoped wall search: the host ranks locally and returns only top-k snippets
   * this participant may see (scope / context pack). Snippets you get are still
   * sent to your model provider.
   */
  async search(q: string, k?: number): Promise<Out> {
    this.alive();
    const query = (q ?? "").trim();
    if (!query) throw new Error("q is required");
    if (k !== undefined) k = Number.isInteger(k) ? Math.max(1, Math.min(8, k)) : undefined;
    const r = this.host ? await this.host.searchLocal(query, k) : await this.peer!.search(query, k);
    return { ok: true, mode: r.mode, hits: r.hits };
  }

  /** Host: changes an agent's permissions. */
  setScope(label: string, raw: string): Out {
    if (!this.host) throw new Error("only the host can change permissions");
    const sc = parseScopeArg(raw);
    if (!sc) throw new Error("scope: read-only | post | full | comma list of post,files,secrets,limited,search");
    this.host.setAgentScope(label, sc);
    return { ok: true };
  }

  /** Host: adds/removes an entry from an agent's context pack (limited view). */
  share(label: string, id: string, on: boolean): Out {
    if (!this.host) throw new Error("only the host can share entries with an agent");
    this.host.shareWithAgent(label, id, on);
    return { ok: true };
  }

  pin(id: string | null): Out {
    if (!this.host) throw new Error("only the host can pin");
    this.host.pin(id);
    return { ok: true };
  }

  kick(label: string): Out {
    if (!this.host) throw new Error("only the host can disconnect participants");
    this.host.kick(label);
    return { ok: true };
  }

  allowAgents(on: boolean): Out {
    if (!this.host) throw new Error("only the host can change this setting");
    this.host.setAgentsAllowed(on);
    return { ok: true };
  }

  async close(): Promise<void> {
    if (this.host) await this.host.destroy("destroyed").catch(() => this.host?.stop());
    else await this.peer?.leave();
  }
}

/** Status transitions on stderr when FILENYMOUS_DEBUG is set (no content, no keys). */
let lastDebug = "";
function debug(...parts: unknown[]) {
  if (!process.env.FILENYMOUS_DEBUG) return;
  const line = parts.join(" ");
  if (line === lastDebug) return;
  lastDebug = line;
  process.stderr.write(`[debug ${new Date().toISOString().slice(11, 23)}] ${line}\n`);
}

function uniquePath(dir: string, name: string): string {
  let p = join(dir, name);
  for (let i = 1; existsQuiet(p); i++) p = join(dir, name.replace(/(\.[^.]*)?$/, ` (${i})$1`));
  return p;
}
function existsQuiet(p: string) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", html: "text/html", xml: "application/xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", pdf: "application/pdf", zip: "application/zip",
};
export function mimeOf(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Commands shared by JSON Lines and HTTP.

export async function runCommand(agent: WallAgent, c: Record<string, unknown>): Promise<Out> {
  const s = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : undefined);
  switch (c.cmd) {
    case "send":
    case "say":
      return agent.send(s("text") ?? "", s("replyTo"));
    case "react":
      return agent.react(s("id") ?? "", s("emoji") ?? "");
    case "vote":
      return agent.vote(s("id") ?? "", Number(c.option));
    case "poll":
      return agent.poll(s("question") ?? "", Array.isArray(c.options) ? (c.options as string[]) : []);
    case "note":
      return agent.note(s("text") ?? "");
    case "file":
      return agent.file({ path: s("path"), name: s("name"), content: s("content"), base64: c.base64 === true, replyTo: s("replyTo") });
    case "get":
      return agent.get(s("id") ?? "", s("output"));
    case "notes":
      return agent.notes(s("id"));
    case "write-note":
      return agent.writeNote({ id: s("id"), title: s("title"), text: s("text") });
    case "delete-note":
      return agent.deleteNote(s("id") ?? "");
    case "read":
      return { ok: true, ...agent.read(Number(c.since ?? 0), Number(c.limit ?? 50)) };
    case "members":
    case "participants":
      return { ok: true, participants: agent.participants() };
    case "info":
      return { ok: true, ...agent.info() };
    case "tasks":
      return agent.tasks();
    case "search":
      return agent.search(s("q") ?? "", c.k === undefined ? undefined : Number(c.k));
    case "task":
    case "add-task":
      return agent.addTask((s("kind") as TaskKind) ?? "task", s("text") ?? "", s("owner"));
    case "decision":
      return agent.addTask("decision", s("text") ?? "");
    case "update-task":
      return agent.updateTask(s("id") ?? "", { done: typeof c.done === "boolean" ? c.done : undefined, owner: c.owner === null ? null : s("owner"), text: s("text"), state: s("state"), note: s("note"), result: s("result") });
    case "delegate":
      return agent.delegate(s("text") ?? "", s("owner") ?? "");
    case "delete-task":
      return agent.deleteTask(s("id") ?? "");
    case "artifact":
      return agent.postArtifact({ kind: s("kind"), title: s("title"), body: s("body"), actionItems: Array.isArray(c.actionItems) ? (c.actionItems as string[]) : undefined });
    case "scope":
      return agent.setScope(s("label") ?? "", s("scope") ?? "");
    case "share":
      return agent.share(s("label") ?? "", s("id") ?? "", c.on !== false);
    case "pin":
      return agent.pin(s("id") ?? null);
    case "kick":
      return agent.kick(s("label") ?? "");
    case "allow-agents":
      return agent.allowAgents(c.on !== false);
    default:
      throw new Error(`unknown cmd: ${String(c.cmd)} (send, file, note, react, vote, poll, get, read, search, notes, write-note, delete-note, tasks, add-task, decision, update-task, delegate, delete-task, artifact, members, info, leave; host: pin, kick, allow-agents, scope, share)`);
  }
}

/** JSON Lines on stdin (commands) / stdout (events + results). Resolves with the exit code. */
export function runJsonl(agent: WallAgent, write: (o: Out) => void, quiet?: boolean): Promise<number> {
  return new Promise((done) => {
    let closing = false;
    agent.on((e) => {
      write(e);
      if (e.event === "ended" && !closing) setTimeout(() => done(e.reason === "kicked" || e.reason === "agents-off" ? 3 : 0), 50);
    });
    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const t = line.trim();
      if (!t) return;
      let c: Record<string, unknown>;
      try {
        c = JSON.parse(t);
      } catch {
        return write({ event: "error", error: "invalid JSON line" });
      }
      const ref = c.ref;
      if (c.cmd === "leave" || c.cmd === "quit" || c.cmd === "destroy") {
        closing = true;
        await agent.close();
        write({ event: "result", ref, ok: true });
        return done(0);
      }
      try {
        write({ event: "result", ref, cmd: c.cmd, ...(await runCommand(agent, c)) });
      } catch (e) {
        write({ event: "result", ref, cmd: c.cmd, ok: false, error: String((e as Error).message || e) });
      }
    });
    rl.on("close", () => log(quiet, "stdin closed: still connected (send {\"cmd\":\"leave\"} or Ctrl+C to quit)"));
  });
}

// ---------------------------------------------------------------------------
// Local HTTP + SSE bridge: 127.0.0.1 only, bearer token, no CORS.

export async function startHttpBridge(agent: WallAgent, port = 0, token = process.env.FILENYMOUS_HTTP_TOKEN || randomBytes(24).toString("base64url")) {
  const want = Buffer.from(`Bearer ${token}`);
  const authed = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    // DNS-rebinding and browser guards: loopback Host only, no cross-origin browser calls.
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host) || req.headers.origin) return json(res, 403, { error: "forbidden" });
    if (!authed(req)) return json(res, 401, { error: "missing or bad bearer token" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": filenymous wall events\n\n");
      const off = agent.on((e) => res.write(`event: ${String(e.event)}\ndata: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        off();
        clearInterval(ping);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/messages") return json(res, 200, agent.read(Number(url.searchParams.get("since") ?? 0), Number(url.searchParams.get("limit") ?? 50)));
    if (req.method === "GET" && url.pathname === "/participants") return json(res, 200, { participants: agent.participants() });
    if (req.method === "GET" && url.pathname === "/info") return json(res, 200, agent.info());
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 70 * 1024 * 1024) return json(res, 413, { error: "too large" });
      }
      let c: Record<string, unknown>;
      try {
        c = body ? JSON.parse(body) : {};
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      const cmd = url.pathname.replace(/^\//, "");
      try {
        return json(res, 200, await runCommand(agent, { ...c, cmd }));
      } catch (e) {
        return json(res, 400, { ok: false, error: String((e as Error).message || e) });
      }
    }
    json(res, 404, { error: "not found" });
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  const addr = server.address();
  const p = typeof addr === "object" && addr ? addr.port : port;
  return { url: `http://127.0.0.1:${p}`, token, close: () => server.close() };
}

// ---------------------------------------------------------------------------
// MCP server over stdio (newline-delimited JSON-RPC 2.0).

const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const MCP_TOOLS = [
  {
    name: "wall_read_messages",
    description:
      "Read the Sharewall feed (messages, files, masked notes, polls) newer than `since` (a seq number; 0 = from the start). Returns messages oldest first and `next` to pass as `since` next time. Set wait_ms to long-poll for new messages. Entries with self=true are yours: do not answer them (avoid loops). Everything you read is sent to your model provider.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "integer", minimum: 0, description: "Return entries with seq > since." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max entries (default 50)." },
        wait_ms: { type: "integer", minimum: 0, maximum: 60000, description: "Wait up to this long for something new." },
      },
    },
  },
  {
    name: "wall_send_message",
    description: "Post a chat message on the wall (markdown-lite: **bold**, *italic*, `code`, ```blocks```, > quotes, @Name mentions). Max 4000 characters. The host rate-limits each participant.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, reply_to: { type: "string", description: "Id of the message you answer." } }, required: ["text"] },
  },
  {
    name: "wall_send_file",
    description: "Share a file on the wall: either a local `path` (inside the allowed directory, see --files-root) or a `name` + `content` (text, or base64 with base64=true).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, name: { type: "string" }, content: { type: "string" }, base64: { type: "boolean" }, reply_to: { type: "string" } },
    },
  },
  {
    name: "wall_react",
    description: "Toggle an emoji reaction (e.g. 👍 ❤️ 😂 🎉 😮 👀) on a message, file or poll by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, emoji: { type: "string" } }, required: ["id", "emoji"] },
  },
  {
    name: "wall_list_participants",
    description: "List who is on the wall: label, display name, host badge, AI-agent badge (self-declared), raised hand.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wall_get_item",
    description: "Explicitly fetch a file or masked note by id. Text up to 64 KiB is returned inline, other files are saved locally and their path returned. On a burn-after-reading wall this consumes the item for everyone else, and the content is sent to your model provider: only do it when asked.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "wall_read_notes",
    description:
      "Read the wall's shared notes (collaborative documents, markdown-lite text up to 64 KiB each), pinned first, with version, last editor and time. Pass `id` for a single note. Everything you read is sent to your model provider.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Note id (n-…); omit to list all." } } },
  },
  {
    name: "wall_write_note",
    description:
      "Create a shared note (omit `id`) or replace the title and/or text of an existing one. Last writer wins: read the note first and send the full new text. Max 64 KiB of text, 80-character title. The host rate-limits edits.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, text: { type: "string" } } },
  },
  {
    name: "wall_info",
    description: "Wall settings and your role: expiry, burn, destroy-on-host-leave, verification code, your permissions (`scope`: post, files, secrets, limitedView — set by the host), and the invite link when you host it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wall_search",
    description:
      "Search the wall (messages, files by name, polls, notes, tasks) without reading the whole feed. The host ranks locally (semantic in a browser host that enabled the on-device model, keyword otherwise) and returns only the top-k short snippets your permissions allow; with the \"search\" permission a limited-view agent can query beyond its view. Snippets you receive are still sent to your model provider.",
    inputSchema: { type: "object", properties: { q: { type: "string", description: "query, max 200 characters" }, k: { type: "integer", minimum: 1, maximum: 8 } }, required: ["q"] },
  },
  {
    name: "wall_list_tasks",
    description: "Read the wall's shared checklist (tasks with owner and done state) and decisions log. In limited view you only see tasks you own or that the host shared with you. Everything you read is sent to your model provider.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wall_add_task",
    description: 'Add a checklist task (optionally with an owner: a participant label, "me", or omit) or log a decision (kind="decision"). Max 500 characters. Needs the "post" permission.',
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, kind: { type: "string", enum: ["task", "decision"] }, owner: { type: "string", description: 'Participant label (peer:N, host) or "me".' } },
      required: ["text"],
    },
  },
  {
    name: "wall_update_task",
    description: "Tick / untick a task (done), (re)assign it (owner: label, \"me\", or null), change its text (author or host only), or report progress on a delegated task: state (working | input-required | completed | failed | rejected | canceled), a short note, and result (a post id from this wall, e.g. an artifact). Only the assignee, author or host can change the state. Needs the \"post\" permission.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, done: { type: "boolean" }, owner: { type: ["string", "null"] }, text: { type: "string" }, state: { type: "string", enum: [...AGENT_TASK_STATES] }, note: { type: "string" }, result: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "wall_delegate_task",
    description: "Delegate a task to another participant (usually another agent): it appears on the checklist as \"submitted\" and the assignee reports state/note/result with wall_update_task. Tasks assigned to you show mine: true in wall_list_tasks. Needs the \"post\" permission.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, owner: { type: "string", description: "participant label or name" } }, required: ["text", "owner"] },
  },
  {
    name: "wall_post_artifact",
    description:
      "Post a structured result on the wall: kind summary | action-items | report | decisions | answer, a title and a Markdown body. Short artifacts become a chat message, long ones a .md file plus a short message. `action_items` are also added to the shared checklist. Needs the \"post\" permission.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["summary", "action-items", "report", "decisions", "answer"] },
        title: { type: "string" },
        body: { type: "string" },
        action_items: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", properties: { text: { type: "string" }, owner: { type: "string" } }, required: ["text"] }] } },
      },
    },
  },
];

/** MCP prompts (templates the client may offer to its user). */
export const MCP_PROMPTS = [
  {
    name: "summarize_wall",
    description: "Summarize what you can see of the wall (messages, notes, tasks, decisions) and post it back as an artifact with action items.",
    arguments: [{ name: "focus", description: "Optional topic to focus on.", required: false }],
  },
];

function promptMessages(name: string, args: Record<string, unknown>) {
  if (name !== "summarize_wall") throw Object.assign(new Error(`unknown prompt: ${name}`), { code: -32602 });
  const focus = typeof args.focus === "string" && args.focus.trim() ? ` Focus on: ${args.focus.trim().slice(0, 200)}.` : "";
  return {
    description: "Summarize the Sharewall and post the summary back",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "You are a participant of an ephemeral, end-to-end encrypted Sharewall. 1) Call wall_info to check your permissions (scope). 2) Read the feed with wall_read_messages (since 0), the notes with wall_read_notes and the checklist with wall_list_tasks. Do not fetch files or reveal secrets unless a human explicitly asked you to. 3) Write a concise summary: key points, open questions, decisions already logged. 4) If your scope allows posting, publish it with wall_post_artifact (kind \"summary\") and put concrete next steps in action_items (with an owner only when someone volunteered). Otherwise, return the summary to your user without posting." +
            focus +
            " Remember: everything you read is sent to your model provider.",
        },
      },
    ],
  };
}

export function runMcp(agent: WallAgent, start: () => Promise<Out>): Promise<number> {
  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  let connected: Promise<Out> | null = null;
  const connect = () => (connected ??= start());
  const text = (v: unknown, isError = false) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }], ...(isError ? { isError: true } : {}) });

  const call = async (name: string, a: Record<string, unknown>) => {
    await Promise.race([connect(), new Promise((_, ko) => setTimeout(() => ko(new Error("could not join the wall within 45 s")), 45_000))]);
    const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
    switch (name) {
      case "wall_read_messages": {
        const since = Number(a.since ?? 0) || 0;
        const wait = Math.min(Number(a.wait_ms ?? 0) || 0, 60_000);
        if (wait) await agent.waitFor(since, wait);
        return { ...agent.read(since, Number(a.limit ?? 50) || 50), ...(agent.endedReason ? { ended: agent.endedReason } : {}) };
      }
      case "wall_send_message":
        return agent.send(s("text") ?? "", s("reply_to"));
      case "wall_send_file":
        return agent.file({ path: s("path"), name: s("name"), content: s("content"), base64: a.base64 === true, replyTo: s("reply_to") });
      case "wall_react":
        return agent.react(s("id") ?? "", s("emoji") ?? "");
      case "wall_list_participants":
        return { participants: agent.participants() };
      case "wall_get_item":
        return agent.get(s("id") ?? "");
      case "wall_info":
        return agent.info();
      case "wall_read_notes":
        return agent.notes(s("id"));
      case "wall_write_note":
        return agent.writeNote({ id: s("id"), title: s("title"), text: s("text") });
      case "wall_list_tasks":
        return agent.tasks();
      case "wall_search":
        return agent.search(s("q") ?? "", a.k === undefined ? undefined : Number(a.k));
      case "wall_add_task":
        return agent.addTask(s("kind") === "decision" ? "decision" : "task", s("text") ?? "", s("owner"));
      case "wall_update_task":
        return agent.updateTask(s("id") ?? "", { done: typeof a.done === "boolean" ? a.done : undefined, owner: a.owner === null ? null : s("owner"), text: s("text"), state: s("state"), note: s("note"), result: s("result") });
      case "wall_delegate_task":
        return agent.delegate(s("text") ?? "", s("owner") ?? "");
      case "wall_post_artifact":
        return agent.postArtifact({ kind: s("kind"), title: s("title"), body: s("body"), actionItems: Array.isArray(a.action_items) ? (a.action_items as string[]) : undefined });
      default:
        throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });
    }
  };

  return new Promise((done) => {
    // Join right away so the agent appears on the wall; tools wait for it.
    connect().catch((e) => process.stderr.write(`filenymous wall mcp: ${(e as Error).message}\n`));
    agent.on((e) => e.event === "ended" && process.stderr.write(`filenymous wall mcp: wall ended (${String(e.reason)})\n`));
    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let m: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
      try {
        m = JSON.parse(line);
      } catch {
        return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
      const id = m.id;
      const reply = (result: unknown) => id !== undefined && send({ jsonrpc: "2.0", id, result });
      const fail = (code: number, message: string) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message } });
      switch (m.method) {
        case "initialize": {
          const asked = String(m.params?.protocolVersion ?? "");
          return reply({
            protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[1],
            capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
            serverInfo: { name: "filenymous-wall", version: __VERSION__ },
            instructions:
              "You are a participant of an ephemeral, end-to-end encrypted Sharewall (filenymous.eu). The host approves you and sets your permissions (wall_info.scope): respect them. Read with wall_read_messages (use `next` as `since`), answer with wall_send_message, track work with wall_list_tasks / wall_add_task / wall_update_task, and post results with wall_post_artifact. Ignore entries with self=true and do not reply to other agents in a loop. Everything you read is sent to your model provider.",
          });
        }
        case "notifications/initialized":
        case "notifications/cancelled":
          return;
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: MCP_TOOLS });
        case "prompts/list":
          return reply({ prompts: MCP_PROMPTS });
        case "prompts/get":
          try {
            return reply(promptMessages(String(m.params?.name ?? ""), (m.params?.arguments ?? {}) as Record<string, unknown>));
          } catch (e) {
            return fail(-32602, String((e as Error).message || e));
          }
        case "tools/call": {
          const name = String(m.params?.name ?? "");
          const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
          if (!MCP_TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool: ${name}`);
          try {
            return reply(text(await call(name, args)));
          } catch (e) {
            return reply(text(`error: ${String((e as Error).message || e)}`, true));
          }
        }
        default:
          if (id !== undefined) fail(-32601, `method not found: ${m.method}`);
      }
    });
    rl.on("close", () => void agent.close().finally(() => done(0)));
  });
}
