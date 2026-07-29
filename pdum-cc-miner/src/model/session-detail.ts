/**
 * session-detail.ts — the drill-down's pure model (playbook layer 1).
 *
 * One session, turn by turn: what each turn cost, split by cost class, and how
 * big its context was. No framework, no time, no database — the SQL lands in
 * `graph.ts` and the drawing in `ui/SessionDetail.tsx`.
 *
 * ## Why the x axis is a turn ordinal and not wall-clock time
 *
 * Measured on this corpus's five priciest sessions: the largest is **92% idle**
 * over a 12.8-day span, with a **single 4.8-day gap taking 37% of the span**.
 * On a time axis its 2,183 turns collapse into a few slivers separated by
 * emptiness — the exact shape the question ("does cost per turn grow?") needs to
 * see is the part that gets squashed. Ordinal position spends every pixel on a
 * turn.
 *
 * Wall-clock is not discarded, it is demoted: each bar's tooltip carries its
 * timestamp, and `gaps()` marks where the session was put down and picked up
 * again, so "I came back to this a week later" is still legible.
 *
 * ## Context size is derived, not stored
 *
 * No field says how big the context was. The tokens *sent up* on a turn are the
 * next best thing — cache read + cache creation + fresh input — and that is
 * checkable, because a compaction records its own `preTokens`. Against the 40
 * compactions in this corpus the proxy lands **within ±20% on 38**, most within
 * 2%.
 *
 * The two misses are both `hadFallback` turns, and they read ~2.2× high for a
 * reason worth keeping: a fallback re-sends the whole context to the second
 * model, so the turn's summed tokens legitimately count it twice. That is 2
 * turns in 21,583 (0.01%), so the series is honest as drawn — but a turn marked
 * `hadFallback` is showing transmitted tokens, not context size.
 */

/** One turn of the focused session, already priced by cc-assay. */
export interface DetailTurn {
  ts: number;
  costCacheRead: number;
  costCacheCreate: number;
  costOutput: number;
  costInput: number;
  costTotal: number;
  /** cache read + cache creation + fresh input — the context-size proxy. */
  contextTokens: number;
  outputTokens: number;
  model: string | null;
  /** `main` for the session's own turns; a subagent's turns carry its context. */
  context: string;
  agentType: string | null;
  hadFallback: boolean;
}

/** A compaction inside the session: where the context was reset, and by how much. */
export interface DetailCompaction {
  ts: number;
  preTokens: number;
  postTokens: number;
  trigger: string;
}

/** The four cost classes, in stacking order — biggest and dullest at the bottom. */
export const COST_CLASSES = [
  { key: "costCacheRead", label: "cache read", tone: "var(--cco-cache-read)" },
  { key: "costCacheCreate", label: "cache creation", tone: "var(--cco-cache-create)" },
  { key: "costOutput", label: "output", tone: "var(--cco-output)" },
  { key: "costInput", label: "fresh input", tone: "var(--cco-input)" },
] as const;

export type CostClassKey = (typeof COST_CLASSES)[number]["key"];

/**
 * A run of consecutive turns drawn as one bar.
 *
 * A long session has more turns than the chart has pixels — 2,183 turns across
 * ~780px is a third of a pixel each — so bars get grouped. The grouping is by
 * **equal turn count**, and each bar shows its group's **summed** cost.
 *
 * Both halves of that matter, and the alternative is worse in a way this corpus
 * makes concrete. In the priciest session the median turn costs $0.37 while 2%
 * of turns carry 29% of the spend. Plot the *mean* per bucket and a $12.66 turn
 * averaged over twelve neighbours becomes a $1 bar — the chart would quietly
 * flatten a third of the money. Summing keeps the spike tall. And because every
 * bucket holds the same number of turns, comparing bucket heights is still
 * comparing cost per turn, so "is it growing?" survives the grouping intact.
 */
export interface Bucket {
  /** First and last turn ordinal in this bucket, inclusive. */
  from: number;
  to: number;
  turns: number;
  /** Wall-clock range of the bucket, for the tooltip. */
  t0: number;
  t1: number;
  costCacheRead: number;
  costCacheCreate: number;
  costOutput: number;
  costInput: number;
  costTotal: number;
  /** The priciest single turn inside, so a spike is attributable to a turn. */
  maxTurnCost: number;
}

/** One stacked segment: a bucket's spend in one cost class. */
export interface StackSegment {
  bucket: Bucket;
  klass: string;
  cost: number;
}

/**
 * Group turns into at most `maxBars` buckets of equal turn count.
 *
 * Below the limit every turn is its own bucket and nothing is lost — a short
 * session is drawn exactly per-turn.
 */
export function bucketTurns(turns: readonly DetailTurn[], maxBars: number): Bucket[] {
  if (turns.length === 0) return [];
  const size = Math.max(1, Math.ceil(turns.length / Math.max(1, maxBars)));
  const out: Bucket[] = [];
  for (let from = 0; from < turns.length; from += size) {
    const to = Math.min(from + size, turns.length) - 1;
    const b: Bucket = {
      from,
      to,
      turns: to - from + 1,
      t0: turns[from].ts,
      t1: turns[to].ts,
      costCacheRead: 0,
      costCacheCreate: 0,
      costOutput: 0,
      costInput: 0,
      costTotal: 0,
      maxTurnCost: 0,
    };
    for (let i = from; i <= to; i++) {
      const t = turns[i];
      b.costCacheRead += t.costCacheRead;
      b.costCacheCreate += t.costCacheCreate;
      b.costOutput += t.costOutput;
      b.costInput += t.costInput;
      b.costTotal += t.costTotal;
      b.maxTurnCost = Math.max(b.maxTurnCost, t.costTotal);
    }
    out.push(b);
  }
  return out;
}

/**
 * Long-form the buckets into one row per (bucket, cost class), the shape a
 * stacked bar mark wants.
 *
 * Zero-cost segments are dropped rather than drawn: fresh input is 0.1% of
 * spend, so keeping them would add marks that render as nothing.
 */
export function stack(buckets: readonly Bucket[]): StackSegment[] {
  const out: StackSegment[] = [];
  for (const bucket of buckets) {
    for (const c of COST_CLASSES) {
      const cost = bucket[c.key];
      if (cost > 0) out.push({ bucket, klass: c.label, cost });
    }
  }
  return out;
}

/** Where a compaction falls on an ordinal axis: the last turn at or before it. */
export interface CompactionMark extends DetailCompaction {
  /** Turn ordinal to draw at. -1 when the compaction precedes every turn. */
  i: number;
}

/**
 * Place each compaction on the ordinal axis.
 *
 * Compactions are timestamped and the axis is not, so each one is pinned to the
 * last turn that had already happened. Binary search rather than a scan: the
 * turns are sorted and a long session has thousands of them.
 */
export function placeCompactions(
  turns: readonly DetailTurn[],
  compactions: readonly DetailCompaction[],
): CompactionMark[] {
  return compactions
    .map((c) => {
      let lo = 0;
      let hi = turns.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (turns[mid].ts <= c.ts) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return { ...c, i: found };
    })
    .sort((a, b) => a.i - b.i);
}

/** A stretch of wall-clock time in which the session produced nothing. */
export interface IdleGap {
  /** Ordinal of the turn BEFORE the gap; the gap sits between `i` and `i + 1`. */
  i: number;
  ms: number;
}

/**
 * Idle gaps longer than `thresholdMs`, so a time-free axis can still show where
 * the work stopped.
 *
 * The threshold is the same idle-gap control the sessions table uses, so "what
 * counts as putting it down" is one decision the reader makes once.
 */
export function gaps(turns: readonly DetailTurn[], thresholdMs: number): IdleGap[] {
  const out: IdleGap[] = [];
  for (let i = 1; i < turns.length; i++) {
    const ms = turns[i].ts - turns[i - 1].ts;
    if (ms >= thresholdMs) out.push({ i: i - 1, ms });
  }
  return out;
}

/** What the drill-down's header reports. */
export interface DetailSummary {
  turns: number;
  cost: number;
  /** Mean cost of the first and last fifth — the "is it getting worse" number. */
  firstFifthMean: number;
  lastFifthMean: number;
  peakContextTokens: number;
  /** Turns that ran in a subagent rather than the main loop. */
  subagentTurns: number;
}

/**
 * Summarise the session, including the growth comparison the panel leads with.
 *
 * First-fifth vs last-fifth rather than a fitted slope: the series is spiky and
 * a regression line over it invites reading a trend into noise, while two means
 * over a fifth each are a claim a reader can check by eye against the bars.
 * Only MAIN-context turns count toward the means — a subagent's cost says
 * nothing about whether the session's own context is growing.
 */
export function summarise(turns: readonly DetailTurn[]): DetailSummary {
  const main = turns.filter((t) => t.context === "main");
  const fifth = Math.max(1, Math.floor(main.length / 5));
  const mean = (xs: DetailTurn[]) =>
    xs.length ? xs.reduce((s, t) => s + t.costTotal, 0) / xs.length : 0;
  return {
    turns: turns.length,
    cost: turns.reduce((s, t) => s + t.costTotal, 0),
    firstFifthMean: mean(main.slice(0, fifth)),
    lastFifthMean: mean(main.slice(-fifth)),
    peakContextTokens: main.reduce((m, t) => Math.max(m, t.contextTokens), 0),
    subagentTurns: turns.length - main.length,
  };
}
