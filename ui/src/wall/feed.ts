/**
 * Sharewall live feed: posts (messages, files, masked notes, polls), members
 * (presence), reactions, mentions, grouping and rate limiting. Pure logic,
 * shared by the host (authoritative copy), the peers and the CLI agents.
 * Everything here lives in memory only.
 */
import type { ItemMeta } from "./model";

export type PostKind = "msg" | "file" | "note" | "poll";

export interface Poll {
  question: string;
  options: string[];
  /** votes[i] = labels of the members who picked option i (single choice). */
  votes: string[][];
  closed: boolean;
}

export interface Post {
  id: string;
  kind: PostKind;
  /** Author label: "host" or "peer:N". */
  by: string;
  at: number;
  text?: string;
  replyTo?: string;
  /** Labels mentioned with @Name. */
  mentions?: string[];
  item?: ItemMeta;
  poll?: Poll;
  /** emoji → labels of the members who reacted. */
  reactions: Record<string, string[]>;
}

export interface Member {
  label: string;
  name: string;
  /** Self-declared by the client: cannot be verified. */
  agent: boolean;
  host: boolean;
  hand: boolean;
  /** Can receive live audio/video (browsers; not the CLI). */
  media: boolean;
}

export type LiveKind = "screen" | "camera";
export interface LiveInfo {
  sid: string;
  by: string;
  kind: LiveKind;
}

export type BurstKind = "applause" | "party" | "heart";
export const BURSTS: Record<BurstKind, string> = { applause: "👏", party: "🎉", heart: "❤️" };

export const MAX_MSG_CHARS = 4000;
export const MAX_POSTS = 1000;
export const MAX_NAME = 32;
export const MAX_REACTION_KINDS = 20;
export const POLL_MIN = 2;
export const POLL_MAX = 6;
export const MAX_LIVE = 2;

const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const clean = (v: string, max: number) => v.replace(CTRL, "").slice(0, max);

/** Display names: no control or bidi-override characters, single spaces, ≤ 32 chars. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(CTRL, "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
}

/** Message text: keeps line breaks and tabs, drops other control/bidi characters. */
export function cleanMessage(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return clean(raw.replace(/\r\n?/g, "\n"), MAX_MSG_CHARS).replace(/\n{4,}/g, "\n\n\n").trim();
}

const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200d\ufe0f\u20e3#*0-9]|\p{Emoji_Modifier})+$/u;
export function isEmoji(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= 16 && EMOJI_RE.test(s) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s);
}

const ANIMALS = {
  fr: ["Loutre", "Renard", "Hibou", "Lynx", "Panda", "Koala", "Faucon", "Dauphin", "Castor", "Hérisson", "Lama", "Tigre", "Manchot", "Écureuil", "Baleine", "Colibri"],
  en: ["Otter", "Fox", "Owl", "Lynx", "Panda", "Koala", "Falcon", "Dolphin", "Beaver", "Hedgehog", "Llama", "Tiger", "Penguin", "Squirrel", "Whale", "Hummingbird"],
};
const COLORS = {
  fr: ["Azur", "Corail", "Jade", "Ambre", "Indigo", "Saphir", "Opale", "Cobalt", "Safran", "Menthe", "Lilas", "Cerise"],
  en: ["Azure", "Coral", "Jade", "Amber", "Indigo", "Sapphire", "Opal", "Cobalt", "Saffron", "Mint", "Lilac", "Cherry"],
};

/** Random friendly pseudonym ("Loutre Jade" / "Jade Otter"); never derived from identity. */
export function pseudonym(lang: string, rand: () => number = Math.random): string {
  const l = lang.startsWith("en") ? "en" : "fr";
  const a = ANIMALS[l][Math.floor(rand() * ANIMALS[l].length)]!;
  const c = COLORS[l][Math.floor(rand() * COLORS[l].length)]!;
  return l === "en" ? `${c} ${a}` : `${a} ${c}`;
}

/** Stable avatar hue for a member label. */
export function avatarHue(label: string): number {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 16777619);
  return Math.abs(h) % 360;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const chars = parts.length > 1 ? [parts[0]!, parts[1]!].map((p) => Array.from(p)[0]) : Array.from(parts[0] ?? "?").slice(0, 2);
  return chars.join("").toUpperCase() || "?";
}

/** Labels of members mentioned as "@Name" (longest names first, case-insensitive, word boundaries). */
export function extractMentions(text: string, members: Pick<Member, "label" | "name">[]): string[] {
  const lower = text.toLowerCase();
  const claimed = new Set<number>();
  const out: string[] = [];
  for (const m of [...members].sort((a, b) => b.name.length - a.name.length)) {
    if (!m.name) continue;
    const needle = `@${m.name.toLowerCase()}`;
    for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + 1)) {
      const before = i === 0 ? undefined : lower[i - 1];
      const next = lower[i + needle.length];
      if (claimed.has(i) || (before !== undefined && /[\p{L}\p{N}_]/u.test(before)) || (next !== undefined && /[\p{L}\p{N}_-]/u.test(next))) continue;
      claimed.add(i);
      if (!out.includes(m.label)) out.push(m.label);
    }
  }
  return out;
}

/** Toggles `label`'s `emoji` reaction; returns a new post (or the same one if refused). */
export function toggleReaction(post: Post, emoji: string, label: string): Post {
  if (!isEmoji(emoji)) return post;
  const reactions = { ...post.reactions };
  const who = reactions[emoji] ?? [];
  if (who.includes(label)) {
    const rest = who.filter((l) => l !== label);
    if (rest.length) reactions[emoji] = rest;
    else delete reactions[emoji];
  } else {
    if (!reactions[emoji] && Object.keys(reactions).length >= MAX_REACTION_KINDS) return post;
    reactions[emoji] = [...who, label];
  }
  return { ...post, reactions };
}

export function makePoll(question: unknown, options: unknown): Poll | null {
  const q = typeof question === "string" ? clean(question, 200).replace(/\s+/g, " ").trim() : "";
  if (!q || !Array.isArray(options)) return null;
  const opts = options.map((o) => (typeof o === "string" ? clean(o, 80).replace(/\s+/g, " ").trim() : "")).filter(Boolean);
  if (opts.length < POLL_MIN || opts.length > POLL_MAX || new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) return null;
  return { question: q, options: opts, votes: opts.map(() => []), closed: false };
}

/** Single-choice vote: picking the current choice again removes the vote. */
export function castVote(post: Post, option: number, label: string): Post {
  const poll = post.poll;
  if (!poll || poll.closed || !Number.isInteger(option) || option < 0 || option >= poll.options.length) return post;
  const had = poll.votes[option]!.includes(label);
  const votes = poll.votes.map((v) => v.filter((l) => l !== label));
  if (!had) votes[option] = [...votes[option]!, label];
  return { ...post, poll: { ...poll, votes } };
}

export function pollTotals(poll: Poll): { counts: number[]; total: number } {
  const counts = poll.votes.map((v) => v.length);
  return { counts, total: counts.reduce((a, b) => a + b, 0) };
}

/** Feed rows: consecutive posts by the same author within `gapMs` are grouped. */
export function groupPosts<P extends Pick<Post, "by" | "at" | "replyTo">>(posts: P[], gapMs = 5 * 60_000): Array<{ post: P; first: boolean }> {
  return posts.map((post, i) => {
    const prev = posts[i - 1];
    const first = !prev || prev.by !== post.by || post.at - prev.at > gapMs || !!post.replyTo;
    return { post, first };
  });
}

/**
 * Token bucket per key (member label): `capacity` actions, refilled at
 * `perSecond`. Used by the host to stop spam and agent loops.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    readonly capacity: number,
    readonly perSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.perSecond);
    b.at = t;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** ms until the next action is allowed. */
  retryIn(key: string): number {
    const b = this.buckets.get(key);
    if (!b || b.tokens >= 1) return 0;
    return Math.ceil(((1 - b.tokens) / this.perSecond) * 1000);
  }

  forget(key: string) {
    this.buckets.delete(key);
  }
}

// ---- validation of what the host sends (peers never trust raw input) -----

const isStr = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const isInt = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const LABEL_RE = /^(host|peer:\d{1,6})$/;
export const isLabel = (v: unknown): v is string => typeof v === "string" && LABEL_RE.test(v);
const ID_RE = /^[a-z0-9-]{1,64}$/;
export const isPostId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

export function cleanMember(m: unknown): Member | null {
  const o = m as Record<string, unknown>;
  if (!o || typeof o !== "object" || !isLabel(o.label)) return null;
  return {
    label: o.label,
    name: cleanName(o.name) || o.label,
    agent: o.agent === true,
    host: o.label === "host",
    hand: o.hand === true,
    media: o.media === true,
  };
}

export function cleanLive(l: unknown): LiveInfo | null {
  const o = l as Record<string, unknown>;
  if (!o || typeof o !== "object" || !isPostId(o.sid) || !isLabel(o.by) || (o.kind !== "screen" && o.kind !== "camera")) return null;
  return { sid: o.sid, by: o.by, kind: o.kind };
}

export function cleanReactions(r: unknown): Record<string, string[]> | null {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const out: Record<string, string[]> = {};
  const entries = Object.entries(r as Record<string, unknown>);
  if (entries.length > MAX_REACTION_KINDS) return null;
  for (const [emoji, who] of entries) {
    if (!isEmoji(emoji) || !Array.isArray(who) || who.length > 64 || !who.every(isLabel)) return null;
    out[emoji] = who as string[];
  }
  return out;
}

export function cleanPost(p: unknown, cleanItem: (m: unknown) => ItemMeta | null): Post | null {
  const o = p as Record<string, unknown>;
  if (!o || typeof o !== "object" || !isPostId(o.id) || !isLabel(o.by) || !isInt(o.at)) return null;
  if (o.kind !== "msg" && o.kind !== "file" && o.kind !== "note" && o.kind !== "poll") return null;
  const reactions = cleanReactions(o.reactions ?? {});
  if (!reactions) return null;
  const post: Post = { id: o.id, kind: o.kind, by: o.by, at: o.at as number, reactions };
  if (o.replyTo !== undefined) {
    if (!isPostId(o.replyTo)) return null;
    post.replyTo = o.replyTo;
  }
  if (o.mentions !== undefined) {
    if (!Array.isArray(o.mentions) || o.mentions.length > 16 || !o.mentions.every(isLabel)) return null;
    post.mentions = o.mentions as string[];
  }
  if (o.kind === "msg") {
    if (!isStr(o.text, MAX_MSG_CHARS + 16)) return null;
    post.text = cleanMessage(o.text);
    if (!post.text) return null;
  } else if (o.kind === "poll") {
    const q = o.poll as Record<string, unknown> | undefined;
    const poll = q && makePoll(q.question, q.options);
    if (!poll || !Array.isArray(q.votes) || q.votes.length !== poll.options.length) return null;
    for (const v of q.votes) if (!Array.isArray(v) || v.length > 64 || !v.every(isLabel)) return null;
    poll.votes = q.votes as string[][];
    poll.closed = q.closed === true;
    post.poll = poll;
  } else {
    const item = cleanItem(o.item);
    if (!item || item.id !== o.id || (o.kind === "note") !== (item.kind === "text")) return null;
    post.item = item;
  }
  return post;
}

/** Events emitted by the host and peer engines (UI effects, CLI JSON Lines). */
export type WallEvent =
  | { type: "post"; post: Post; update: boolean }
  | { type: "unpost"; id: string }
  | { type: "join"; member: Member }
  | { type: "leave"; member: Member }
  | { type: "members"; members: Member[] }
  | { type: "pin"; id: string | null }
  | { type: "live"; streams: LiveInfo[] }
  | { type: "typing"; label: string }
  | { type: "burst"; label: string; kind: BurstKind }
  | { type: "notice"; code: string; retryMs?: number };

/** Host-side limits per member (the host itself is exempt). */
export const LIMITS = {
  chat: { capacity: 8, perSecond: 1 / 1.5 },
  react: { capacity: 20, perSecond: 4 },
  burst: { capacity: 3, perSecond: 1 / 3 },
  typingGapMs: 2000,
} as const;

export function randomPostId(prefix: string): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return `${prefix}${Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 10)}`;
}

/** Diff of two member lists: who joined, who left. */
export function diffMembers(before: Member[], after: Member[]): { joined: Member[]; left: Member[] } {
  const b = new Set(before.map((m) => m.label));
  const a = new Set(after.map((m) => m.label));
  return { joined: after.filter((m) => !b.has(m.label)), left: before.filter((m) => !a.has(m.label)) };
}
