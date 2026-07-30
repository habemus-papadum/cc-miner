/**
 * SourceSwitch.tsx — which corpus engine is answering, and how to change it.
 *
 * This lives in the HEADER, outside the dataset `CellView`, and that placement is
 * load-bearing rather than cosmetic. Asking for `host` with no host running is a
 * terminal error by design — there is deliberately no fallback to local bytes —
 * so a switcher rendered inside the data region would vanish at exactly the
 * moment you need it and strand the app in a mode it cannot leave.
 *
 * Switching reloads the page. `setSourceMode` persists the choice and navigates
 * with `?source=`, because the mode is *declared at boot*: the coordinator's
 * connector is chosen once, and swapping it under a live Mosaic graph would mean
 * two paths to the data that agree only while both happen to end at the same
 * engine. A reload is honest and costs a second.
 */
import { For, Show } from "solid-js";
import type { SourceMode } from "../model/source-mode";
import { MODES, setSourceMode, sourceLabel, sourceMode } from "../model/store";

const HINTS: Record<SourceMode, string> = {
  local: "DuckDB-WASM in this page, over corpus shards it fetches (dev only)",
  host: "a native DuckDB process; the SQL travels, not the table",
};

export function SourceSwitch() {
  const current = () => sourceMode.get();
  /** Only what this build has — `local` is dev-only; see source-mode.ts. */
  const offered = () => MODES.map((id) => ({ id, hint: HINTS[id] }));
  return (
    <div class="cco-source">
      {/* One mode is not a choice. A production build has only `host`, and a
          lone button that cannot be unpressed reads as broken rather than as
          informative — the provenance label below already says where the data
          came from, which is the part worth keeping. */}
      <Show when={offered().length > 1}>
        <For each={offered()}>
          {(m) => (
            <button
              type="button"
              class={`cco-source-btn${current() === m.id ? " is-on" : ""}`}
              title={m.hint}
              aria-pressed={current() === m.id ? "true" : "false"}
              onClick={() => {
                if (current() !== m.id) setSourceMode(m.id);
              }}
            >
              {m.id}
            </button>
          )}
        </For>
      </Show>
      {/* Provenance, not decoration: in host mode this names the directory or S3
          prefix actually being served, which is the only way to tell a stale
          corpus from the real one. */}
      <span class="cco-source-label">{sourceLabel()}</span>
    </div>
  );
}
