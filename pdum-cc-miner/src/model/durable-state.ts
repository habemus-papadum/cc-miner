/**
 * durable-state.ts — a durable value with a reactive mirror.
 *
 * ## The hazard this exists for
 *
 * Solid 2 **stages** writes until the next microtask, so `set(x)` followed by
 * `get()` in one synchronous flow returns the PRE-write value. aiui-viz's
 * `durableSignal` ships a guard that shouts about exactly this, and its comment
 * records seven live sightings before the cause was understood. This app added
 * four more in one sitting.
 *
 * The shape that triggers it is *any handler that computes its next state from
 * its current state* — which is every toggle on this page:
 *
 * ```ts
 * // wrong: rapid clicks all read the same committed base, last write wins
 * visible.set(toggled(visible.get(), project));
 * ```
 *
 * It hides in testing because a test clicks slowly. Eight chips clicked in one
 * tick left **one** deselected; eight clicked a second apart worked perfectly.
 * The version-counter case was worse and silent: two clauses landing in one
 * tick both read the same number, both wrote it, and every filter-keyed panel
 * skipped its recompute.
 *
 * ## The shape that works
 *
 * Authority in a plain box — always current, never staged — with the signal as
 * a mirror for rendering. `peek()` in handlers, `get()` in JSX.
 *
 * The alternative, a functional updater (`set(prev => …)`), reads staged state
 * correctly but gives the caller no way to see the resolved value, and these
 * setters have to hand it straight to Mosaic.
 */

/** A durable value plus its reactive mirror. */
export interface DurableState<T> {
  /** Reactive read — tracks. Use in JSX and memos. */
  get: () => T;
  /** Synchronous read of the latest value, staged or committed. Use in handlers. */
  peek: () => T;
  set: (next: T) => void;
}

/**
 * Build one over an existing box and signal.
 *
 * Takes both rather than creating them so the caller supplies its own scope's
 * `durable`/`durableSignal` — and so this is testable without a scope at all.
 */
export function durableState<T>(
  box: { v: T },
  signal: { get: () => T; set: (next: never) => unknown },
): DurableState<T> {
  return {
    get: signal.get,
    peek: () => box.v,
    set: (next: T) => {
      box.v = next;
      signal.set(next as never);
    },
  };
}

/** Toggle membership without mutating in place — Solid compares by identity. */
export function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}
