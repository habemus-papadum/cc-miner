/**
 * SessionReplay.tsx — read one session back (playbook layer 3).
 *
 * The finest drill-down, and the only view that shows what was actually *said*.
 * Everything else on this page is derived from token counts; this is the
 * transcript.
 *
 * Three things shape it:
 *
 * **Hours are the navigation unit** — the user's own framing was "the whole
 * session or one hour within it". The strip along the top is one cell per hour
 * that had activity (empty hours are omitted: the priciest session is 92% idle,
 * and a strip of 307 blanks is not navigation). Click one to scope to it.
 *
 * **Agents are a filter, not a separate view.** A subagent's blocks are
 * interleaved in the same stream, tagged with their agent. You can read the
 * whole session including its excursions, or narrow to the main loop, or to one
 * agent — same list, filtered.
 *
 * **Failures are the thing you are usually looking for.** A tool call that
 * failed is marked and its error kept, because "what the hell went wrong" is
 * the question that brings someone here.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import { createMemo, createSignal, For, Show } from "solid-js";
import { graph, type ReplayData } from "../model/graph";
import { agentTracks, fold, hourBuckets, type ReplayItem, withinHour } from "../model/replay";

/** Rendering thousands of DOM rows helps nobody; the note says what was cut. */
const MAX_ROWS = 400;
/** How many agent chips fit before the list becomes its own scrolling problem. */
const AGENT_CHIPS = 8;

const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
const dayHour = (t: number) => `${new Date(t).toISOString().slice(0, 13).replace("T", " ")}:00`;
const ms = (n: number | null) =>
  n === null ? "" : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`;

/** Characters shown before a prose block is clamped. About eight lines. */
const PROSE_CLAMP = 560;

function Prose(props: { text: string | null; tone: string }) {
  const [open, setOpen] = createSignal(false);
  const full = () => props.text ?? "";
  const long = () => full().length > PROSE_CLAMP;
  return (
    <div class={`cco-rp-text ${props.tone}`}>
      {open() || !long() ? full() : `${full().slice(0, PROSE_CLAMP)}…`}
      <Show when={long()}>
        <button type="button" class="cco-rp-expand" onClick={() => setOpen(!open())}>
          {open() ? "less" : `+${(full().length - PROSE_CLAMP).toLocaleString()} chars`}
        </button>
      </Show>
    </div>
  );
}

function Block(props: { item: ReplayItem }) {
  const it = () => props.item;
  const [open, setOpen] = createSignal(false);

  return (
    <div class={`cco-rp-block cco-rp-${it().kind}${it().failed ? " cco-rp-failed" : ""}`}>
      <span class="cco-rp-time">{it().ts ? hhmm(it().ts) : ""}</span>
      <Show when={it().agentId}>
        {/* Which agent produced this. Only on excursions — the main loop is the
            default and labelling every one of its blocks would be noise. */}
        <span class="cco-rp-agent" title={it().context}>
          {it().agentId?.slice(0, 12)}
        </span>
      </Show>
      <div class="cco-rp-body">
        {/* Prose is clamped until clicked. A single assistant turn runs to
            thousands of words and one of them fills the panel, which makes the
            transcript unscannable — the thing you came here to do. Nothing is
            hidden: the block says how much more there is. */}
        <Show when={it().kind === "prompt"}>
          <div class="cco-rp-label">you</div>
          <Prose text={it().text} tone="" />
        </Show>
        <Show when={it().kind === "text"}>
          <Prose text={it().text} tone="cco-rp-assistant" />
        </Show>
        <Show when={it().kind === "thinking"}>
          {/* The transcript stores `thinking: ""` — only the signature survives.
              So this can say that thinking happened and never what it was. */}
          <div class="cco-rp-thinking">thought (content not retained)</div>
        </Show>
        <Show when={it().kind === "compaction"}>
          <div class="cco-rp-compaction">compaction — {it().text}</div>
        </Show>
        <Show when={it().kind === "image"}>
          <div class="cco-rp-thinking">image · {it().text}</div>
        </Show>
        <Show when={it().kind === "tool_use" || it().kind === "tool_result"}>
          <button
            type="button"
            class="cco-rp-tool"
            onClick={() => setOpen(!open())}
            title="show the output"
          >
            <span class="cco-rp-toolname">{it().toolName ?? "result"}</span>
            <span class="cco-rp-toolarg">{it().text}</span>
            <Show when={it().result?.durationMs}>
              <span class="cco-rp-dur">{ms(it().result?.durationMs ?? null)}</span>
            </Show>
            <span class={`cco-rp-mark${it().failed ? " cco-rp-mark-bad" : ""}`}>
              {it().failed ? "✗" : it().result ? "✓" : "·"}
            </span>
          </button>
          <Show when={it().failed && it().result?.errorKind}>
            <div class="cco-rp-error">{it().result?.errorKind}</div>
          </Show>
          <Show when={open() && it().result}>
            <pre class="cco-rp-out">
              {it().result?.text}
              <Show when={it().result?.truncated}>
                <span class="cco-rp-cut">
                  {"\n"}… showing {it().result?.text?.length} of{" "}
                  {it().result?.fullChars.toLocaleString()} characters
                </span>
              </Show>
            </pre>
          </Show>
        </Show>
        <Show when={it().truncated && it().kind !== "tool_result"}>
          <span class="cco-rp-cut">… of {it().fullChars.toLocaleString()} characters</span>
        </Show>
      </div>
    </div>
  );
}

function Replay(props: { data: ReplayData }) {
  const [hour, setHour] = createSignal<number | null>(null);
  const [agent, setAgent] = createSignal<string | null | undefined>(undefined);

  const items = createMemo(() => fold(props.data.rows));
  const hours = createMemo(() => hourBuckets(items()));
  const tracks = createMemo(() => agentTracks(items()));
  const shown = createMemo(() => {
    const a = agent();
    const inHour = withinHour(items(), hour());
    return a === undefined ? inHour : inHour.filter((i) => i.agentId === a);
  });
  const maxBlocks = createMemo(() => Math.max(1, ...hours().map((h) => h.blocks)));

  return (
    <>
      <div class="cco-rp-controls">
        <div class="cco-rp-hours">
          <button
            type="button"
            class={`cco-rp-hour cco-rp-hour-all${hour() === null ? " cco-rp-on" : ""}`}
            onClick={() => setHour(null)}
          >
            all
          </button>
          <For each={hours()}>
            {(h) => (
              <button
                type="button"
                class={`cco-rp-hour${hour() === h.hour ? " cco-rp-on" : ""}${h.failures ? " cco-rp-hour-bad" : ""}`}
                // Height encodes volume so the strip doubles as a shape of the
                // session — where the work actually happened.
                style={{ "--fill": `${(h.blocks / maxBlocks()) * 100}%` }}
                onClick={() => setHour(hour() === h.hour ? null : h.hour)}
                title={`${dayHour(h.hour)} · ${h.blocks} blocks · ${h.prompts} prompts · ${h.toolCalls} tool calls${h.failures ? ` · ${h.failures} failed` : ""}`}
              />
            )}
          </For>
        </div>
        <Show when={tracks().length > 1}>
          <div class="cco-rp-agents">
            <button
              type="button"
              class={`cco-btn${agent() === undefined ? " cco-rp-on" : ""}`}
              onClick={() => setAgent(undefined)}
            >
              everything
            </button>
            <For each={tracks().slice(0, AGENT_CHIPS)}>
              {(t) => (
                <button
                  type="button"
                  class={`cco-btn${agent() === t.agentId ? " cco-rp-on" : ""}`}
                  onClick={() => setAgent(agent() === t.agentId ? undefined : t.agentId)}
                  title={`${t.blocks} blocks`}
                >
                  {t.agentId ? t.agentId.slice(0, 14) : "main loop"}
                </button>
              )}
            </For>
            {/* Never a silent cap: one session here launched 78 agents, and a
                strip that just stops at 8 reads as "that was all of them". */}
            <Show when={tracks().length > AGENT_CHIPS}>
              <span class="cco-rp-more">+{tracks().length - AGENT_CHIPS} more, busiest first</span>
            </Show>
          </div>
        </Show>
      </div>

      <p class="cco-note cco-note-tight">
        {shown().length.toLocaleString()} blocks
        {hour() !== null ? ` in the hour of ${dayHour(hour() ?? 0)}` : " across the session"}
        {shown().length > MAX_ROWS
          ? ` — showing the first ${MAX_ROWS}; pick an hour to narrow.`
          : "."}
      </p>

      <div class="cco-rp-list">
        <For each={shown().slice(0, MAX_ROWS)}>{(it) => <Block item={it} />}</For>
      </div>
    </>
  );
}

export function SessionReplay() {
  return (
    <section class="cco-panel">
      <h2 class="cco-h2">replay</h2>
      <CellView of={graph().replay}>
        {(data) => (
          <Show when={data()} fallback={<p class="cco-note">No session selected.</p>}>
            {(d) => (
              <Show
                when={d().available}
                fallback={
                  <p class="cco-note">
                    This dataset was built without the replay grain. Regenerate with{" "}
                    <code>--replay</code> to read sessions back block by block:
                    <pre class="cco-cmd">
                      pnpm -C apps/cc-assay normalize -- --out ../cc-miner/src/data --replay
                    </pre>
                  </p>
                }
              >
                <Replay data={d()} />
              </Show>
            )}
          </Show>
        )}
      </CellView>
    </section>
  );
}
