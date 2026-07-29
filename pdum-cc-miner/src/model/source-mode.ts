/**
 * source-mode.ts — reading and writing the declared data mode.
 *
 * Kept apart from source.ts (which resolves a mode into a connection) because
 * this half is pure and testable: it is only "what did the operator ask for",
 * with no DuckDB, no network, no Vite.
 *
 * Precedence, highest first:
 *   1. `?source=` in the URL — a one-off override, so a link can pin a mode
 *   2. what the operator last chose, persisted
 *   3. `local` — the default, because it starts with no server running
 *
 * Note what is NOT in that list: availability. A mode is never chosen because
 * something happened to be listening on a port.
 */

export type SourceMode = "local" | "host";

export const DEFAULT_MODE: SourceMode = "local";
const STORAGE_KEY = "pdum-cc-miner.sourceMode";

export function isSourceMode(v: unknown): v is SourceMode {
  return v === "local" || v === "host";
}

/** The mode requested by a URL, if any. Invalid values are ignored, not thrown. */
export function modeFromSearch(search: string): SourceMode | null {
  const v = new URLSearchParams(search).get("source");
  return isSourceMode(v) ? v : null;
}

export interface ModeStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Resolve the declared mode from URL, then storage, then the default. */
export function resolveMode(search: string, store: ModeStore | null): SourceMode {
  const fromUrl = modeFromSearch(search);
  if (fromUrl) return fromUrl;
  const stored = store?.get(STORAGE_KEY);
  return isSourceMode(stored) ? stored : DEFAULT_MODE;
}

/** Remember the operator's choice for the next start. */
export function persistMode(mode: SourceMode, store: ModeStore | null): void {
  store?.set(STORAGE_KEY, mode);
}

/** A `localStorage`-backed store, or null where there is no DOM (tests, SSR). */
export function browserModeStore(): ModeStore | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    };
  } catch {
    // Storage can throw outright in a partitioned or blocked context; a missing
    // store degrades to "default every time", which is still deterministic.
    return null;
  }
}
