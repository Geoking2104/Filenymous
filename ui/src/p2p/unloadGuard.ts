import { useEffect } from "react";
import { holdUnloadGuard, releaseUnloadGuard } from "./unloadGuardCore";

export { holdUnloadGuard, releaseUnloadGuard, unloadGuardActive } from "./unloadGuardCore";


let seq = 0;

/** React hook: holds the guard while `active` is true. */
export function useUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const reason = `hook-${++seq}`;
    holdUnloadGuard(reason);
    return () => releaseUnloadGuard(reason);
  }, [active]);
}
