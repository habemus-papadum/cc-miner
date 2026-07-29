/**
 * replay.ts — the session replay's pure model (playbook layer 1).
 *
 * The finest drill-down: read one session back, block by block, multi-agent
 * aware. The grain it reads is written by cc-assay's `replay.ts` and fetched
 * per session; this module turns its flat rows into something readable.
 *
 * Two transformations do all the work.
 *
 * **Tool calls are folded.** The transcript stores a `tool_use` and its
 * `tool_result` as separate blocks, often far apart — the result arrives on the
 * *next* user record. Read literally that is two lines saying half a thing each.
 * Folded, one line says `Bash · git status · 0.3s ✓`, which is what a reader
 * wants and what makes a failure findable.
 *
 * **Time is bucketed into hours.** A session runs for days and holds thousands
 * of blocks; rendering all of them is neither useful nor fast. The user's own
 * framing was "the whole session or one hour within it", so hours are the unit
 * of navigation, and `hourBuckets` gives the strip you pick from.
 */

/** One row of the replay grain, as it comes out of DuckDB. */
export interface ReplayRow {
  seq: number;
  ts: number;
  agentId: string | null;
  context: string;
  uuid: string | null;
  parentUuid: string | null;
  role: string;
  kind: string;
  text: string | null;
  truncated: boolean;
  fullChars: number;
  toolName: string | null;
  toolUseId: string | null;
  ok: boolean | null;
  errorKind: string | null;
  exitCode: number | null;
  durationMs: number | null;
  model: string | null;
}

/** A block as the view draws it: a tool call carries its own outcome. */
export interface ReplayItem extends ReplayRow {
  /** The matching `tool_result`, folded in. Only on a `tool_use`. */
  result?: {
    text: string | null;
    truncated: boolean;
    fullChars: number;
    ok: boolean | null;
    errorKind: string | null;
    exitCode: number | null;
    durationMs: number | null;
  };
  /** True when this call, or its result, reports failure. */
  failed: boolean;
}

/**
 * Fold each `tool_result` into the `tool_use` it answers, and drop the orphans.
 *
 * Matching is by `toolUseId`, never by adjacency: a result can be thousands of
 * blocks after its call when a tool runs in the background, and adjacency would
 * silently pair a call with someone else's answer.
 *
 * A result whose call is missing is KEPT as its own item rather than dropped —
 * that happens when a fork's prefix contains the answer but not the question,
 * and losing it would leave a hole with no explanation.
 */
export function fold(rows: readonly ReplayRow[]): ReplayItem[] {
  const results = new Map<string, ReplayRow>();
  for (const r of rows) {
    if (r.kind === "tool_result" && r.toolUseId) results.set(r.toolUseId, r);
  }
  const used = new Set<string>();
  const out: ReplayItem[] = [];
  for (const r of rows) {
    if (r.kind === "tool_result") {
      // Kept only if nothing claimed it — see above.
      if (r.toolUseId && results.has(r.toolUseId)) continue;
      out.push({ ...r, failed: r.ok === false });
      continue;
    }
    if (r.kind === "tool_use" && r.toolUseId) {
      const res = results.get(r.toolUseId);
      if (res) used.add(r.toolUseId);
      out.push({
        ...r,
        ...(res
          ? {
              result: {
                text: res.text,
                truncated: res.truncated,
                fullChars: res.fullChars,
                ok: res.ok,
                errorKind: res.errorKind,
                exitCode: res.exitCode,
                durationMs: res.durationMs,
              },
            }
          : {}),
        failed: res?.ok === false || (res?.exitCode ?? 0) > 0,
      });
      continue;
    }
    out.push({ ...r, failed: false });
  }
  // Any result whose call never appeared is re-added in place.
  for (const r of rows) {
    if (r.kind !== "tool_result" || !r.toolUseId || used.has(r.toolUseId)) continue;
    if (out.some((o) => o.seq === r.seq)) continue;
    out.push({ ...r, failed: r.ok === false });
  }
  // Chronological, with `seq` breaking same-millisecond ties — the same order
  // the query asks for, so re-inserting an orphan cannot shuffle the rest.
  // Sorting by `seq` alone would silently undo it: `seq` is file order, and the
  // walk yields a session's subagents before the session file itself.
  return out.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
}

/** One hour of a session: the navigation unit the user asked for. */
export interface HourBucket {
  /** Epoch ms of the hour's start. */
  hour: number;
  blocks: number;
  prompts: number;
  toolCalls: number;
  failures: number;
}

const HOUR = 3600_000;

/**
 * Group items into wall-clock hours, skipping the hours with nothing in them.
 *
 * Empty hours are dropped rather than drawn as gaps because a session spans
 * days while its work occupies a handful of hours — the priciest session in
 * this corpus is 92% idle. A strip with 307 empty cells and 21 full ones is not
 * a navigation aid.
 */
export function hourBuckets(items: readonly ReplayItem[]): HourBucket[] {
  const by = new Map<number, HourBucket>();
  for (const it of items) {
    if (!it.ts) continue;
    const hour = Math.floor(it.ts / HOUR) * HOUR;
    let b = by.get(hour);
    if (!b) {
      b = { hour, blocks: 0, prompts: 0, toolCalls: 0, failures: 0 };
      by.set(hour, b);
    }
    b.blocks++;
    if (it.kind === "prompt") b.prompts++;
    if (it.kind === "tool_use") b.toolCalls++;
    if (it.failed) b.failures++;
  }
  return [...by.values()].sort((a, b) => a.hour - b.hour);
}

/** Restrict to one hour, or pass everything through when `hour` is null. */
export const withinHour = (items: readonly ReplayItem[], hour: number | null): ReplayItem[] =>
  hour === null ? [...items] : items.filter((i) => i.ts >= hour && i.ts < hour + HOUR);

/** The agents that appear in a session, for the "who was running" filter. */
export interface AgentTrack {
  agentId: string | null;
  context: string;
  blocks: number;
}

export function agentTracks(items: readonly ReplayItem[]): AgentTrack[] {
  const by = new Map<string, AgentTrack>();
  for (const it of items) {
    const key = it.agentId ?? "";
    const t = by.get(key);
    if (t) t.blocks++;
    else by.set(key, { agentId: it.agentId, context: it.context, blocks: 1 });
  }
  // Main loop first, then the agents by volume — the main loop is the spine of
  // the session and an agent is an excursion from it.
  return [...by.values()].sort((a, b) =>
    a.agentId === null ? -1 : b.agentId === null ? 1 : b.blocks - a.blocks,
  );
}
