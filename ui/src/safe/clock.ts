/** Vector clocks for shared items: { agentHandle: sequenceNumber }. */
export type VectorClock = Record<string, number>;

export type ClockOrder = "equal" | "before" | "after" | "concurrent";

/** Order of `a` relative to `b`. */
export function compareClocks(a: VectorClock, b: VectorClock): ClockOrder {
  let less = false;
  let more = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    if (x < y) less = true;
    if (x > y) more = true;
  }
  if (less && more) return "concurrent";
  if (less) return "before";
  if (more) return "after";
  return "equal";
}

export function mergeClocks(a: VectorClock, b: VectorClock): VectorClock {
  const out: VectorClock = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}

export function tick(c: VectorClock, me: string): VectorClock {
  return { ...c, [me]: (c[me] ?? 0) + 1 };
}
