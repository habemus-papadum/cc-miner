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
 *   3. the default, `local` where it exists and `host` otherwise
 *
 * Note what is NOT in that list: availability *at runtime*. A mode is never
 * chosen because something happened to be listening on a port — asking for
 * `host` with no host running stays an error, not a downgrade.
 *
 * Which modes EXIST is a different question, and it is a property of the build
 * rather than of the moment: `local` is dev-only (see `availableModes`). Every
 * function here takes that set as an argument instead of consulting
 * `import.meta.env`, so this module stays pure and the rule stays testable.
 */

export const ALL_MODES = ["local", "host"] as const;
export type SourceMode = (typeof ALL_MODES)[number];

export const DEFAULT_MODE: SourceMode = "local";
const STORAGE_KEY = "pdum-cc-miner.sourceMode";

export function isSourceMode(v: unknown): v is SourceMode {
  return v === "local" || v === "host";
}

/**
 * The modes this build offers.
 *
 * `local` is **dev-only**. It exists so `pnpm dev` needs no second process, and
 * as a cross-check — two independent engines over one corpus must agree, which
 * is a real oracle. Neither reason survives into a shipped build:
 *
 *  - Its original justification was a zero-backend static deploy, and that is
 *    gone. Corpus bytes now arrive over `/__corpus` at run time rather than
 *    compiled into `dist/`, so local mode needs something serving that route
 *    anyway. Restoring the static story would mean publishing a corpus — the
 *    personal telemetry the move to `~/.cache/cc-miner` exists to keep private.
 *  - It saves nothing to ship. duckdb-wasm is ~77 MB of the bundle and host
 *    mode needs every byte of it: `quackConnector` wraps `wasmConnector`,
 *    because the page still has to speak Quack's binary wire format.
 *
 * So what is left in production is one engine and one path, which is the point.
 * This is the one place the renderer branches on a build flag; it is about
 * dev-vs-prod, NOT about telling the two hosts apart (see `src/host.ts` — that
 * distinction is answered at runtime and must stay that way).
 *
 * @param dev `import.meta.env.DEV` at the call site
 */
export function availableModes(dev: boolean): readonly SourceMode[] {
  return dev ? ALL_MODES : (["host"] as const);
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

/**
 * Resolve the declared mode from URL, then storage, then the default —
 * considering only modes this build actually has.
 *
 * A mode that is not available is treated exactly like a misspelling: skipped,
 * so the next source of truth gets its turn. That matters for the real case,
 * which is a `local` left in `localStorage` (or in a bookmarked link) by a dev
 * session and then carried into a production build. Falling through is not the
 * "quiet downgrade" this app refuses elsewhere — that rule is about never
 * substituting local bytes when a *host* is missing at runtime. Here the mode
 * does not exist in this build at all, and there is exactly one thing it could
 * have meant.
 */
export function resolveMode(
  search: string,
  store: ModeStore | null,
  available: readonly SourceMode[] = ALL_MODES,
): SourceMode {
  const fallback = available.includes(DEFAULT_MODE) ? DEFAULT_MODE : (available[0] ?? "host");
  const fromUrl = modeFromSearch(search);
  if (fromUrl && available.includes(fromUrl)) return fromUrl;
  const stored = store?.get(STORAGE_KEY);
  if (isSourceMode(stored) && available.includes(stored)) return stored;
  return fallback;
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
