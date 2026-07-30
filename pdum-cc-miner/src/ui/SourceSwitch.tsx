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
import { For } from "solid-js";
import type { SourceMode } from "../model/source-mode";
import { setSourceMode, sourceLabel, sourceMode } from "../model/store";

const MODES: ReadonlyArray<{ id: SourceMode; hint: string }> = [
  { id: "local", hint: "DuckDB-WASM in this page, over corpus shards it fetches" },
  { id: "host", hint: "a native DuckDB process; the SQL travels, not the table" },
];

export function SourceSwitch() {
  const current = () => sourceMode.get();
  return (
    <div class="cco-source">
      <For each={MODES}>
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
      {/* Provenance, not decoration: in host mode this names the directory or S3
          prefix actually being served, which is the only way to tell a stale
          corpus from the real one. */}
      <span class="cco-source-label">{sourceLabel()}</span>
    </div>
  );
}
