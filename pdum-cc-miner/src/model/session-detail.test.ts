/**
 * The drill-down's pure model. Every case here is a shape the real corpus
 * actually contains — see session-detail.ts for the measurements.
 */

import { describe, expect, it } from "vitest";
import {
  bucketTurns,
  type DetailCompaction,
  type DetailTurn,
  gaps,
  placeCompactions,
  stack,
  summarise,
} from "./session-detail";

const T = (o: Partial<DetailTurn> & { ts: number }): DetailTurn => ({
  costCacheRead: 0,
  costCacheCreate: 0,
  costOutput: 0,
  costInput: 0,
  costTotal: 0,
  contextTokens: 0,
  outputTokens: 0,
  model: "claude-opus-5",
  context: "main",
  agentType: null,
  hadFallback: false,
  ...o,
});

const C = (ts: number, pre = 1_000_000): DetailCompaction => ({
  ts,
  preTokens: pre,
  postTokens: 60_000,
  trigger: "auto",
});

describe("bucketTurns", () => {
  const many = (n: number, cost = 1) =>
    Array.from({ length: n }, (_, i) => T({ ts: i * 1000, costTotal: cost, costOutput: cost }));

  it("leaves a short session one bar per turn", () => {
    const b = bucketTurns(many(10), 180);
    expect(b).toHaveLength(10);
    expect(b.every((x) => x.turns === 1)).toBe(true);
    expect(b.map((x) => x.from)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("groups a long session into at most maxBars buckets", () => {
    const b = bucketTurns(many(2183), 180);
    expect(b.length).toBeLessThanOrEqual(180);
    expect(b[0].turns).toBe(Math.ceil(2183 / 180));
    // The last bucket is short — the count rarely divides evenly, and padding
    // it would invent turns that do not exist.
    expect(b.at(-1)?.to).toBe(2182);
  });

  it("SUMS cost rather than averaging it, so a spike survives grouping", () => {
    // The real motivation: 2% of turns carry 29% of spend in this corpus. A
    // mean would fold a $12.66 turn into its neighbours and hide the money.
    const turns = [
      ...Array.from({ length: 11 }, () => T({ ts: 0, costTotal: 0.1, costOutput: 0.1 })),
      T({ ts: 1, costTotal: 12.66, costOutput: 12.66 }),
    ];
    const [b] = bucketTurns(turns, 1);
    expect(b.costTotal).toBeCloseTo(13.76);
    expect(b.maxTurnCost).toBe(12.66);
  });

  it("covers every turn exactly once", () => {
    const b = bucketTurns(many(97), 10);
    expect(b.reduce((s, x) => s + x.turns, 0)).toBe(97);
    for (let i = 1; i < b.length; i++) expect(b[i].from).toBe(b[i - 1].to + 1);
  });

  it("carries the wall-clock range for the tooltip", () => {
    const [b] = bucketTurns(many(5), 1);
    expect(b.t0).toBe(0);
    expect(b.t1).toBe(4000);
  });

  it("is empty-safe", () => {
    expect(bucketTurns([], 180)).toEqual([]);
  });
});

describe("stack", () => {
  const one = (o: Partial<DetailTurn>) => bucketTurns([T({ ts: 1, ...o })], 180);

  it("emits one segment per non-zero cost class", () => {
    const rows = stack(one({ costCacheRead: 0.4, costOutput: 0.1 }));
    expect(rows.map((r) => r.klass)).toEqual(["cache read", "output"]);
  });

  it("drops zero-cost segments rather than drawing invisible marks", () => {
    // Fresh input is 0.1% of all spend, so most turns have a zero there.
    expect(stack(one({ costCacheRead: 1 }))).toHaveLength(1);
    expect(stack(one({}))).toHaveLength(0);
  });

  it("carries its bucket, which is what positions the bar", () => {
    const buckets = bucketTurns([T({ ts: 1, costOutput: 1 }), T({ ts: 2, costOutput: 1 })], 180);
    expect(stack(buckets).map((r) => r.bucket.from)).toEqual([0, 1]);
  });
});

describe("placeCompactions", () => {
  const turns = [T({ ts: 100 }), T({ ts: 200 }), T({ ts: 300 })];

  it("pins a compaction to the last turn at or before it", () => {
    expect(placeCompactions(turns, [C(250)])[0].i).toBe(1);
    expect(placeCompactions(turns, [C(300)])[0].i).toBe(2);
    expect(placeCompactions(turns, [C(9999)])[0].i).toBe(2);
  });

  it("reports -1 for a compaction that precedes every turn", () => {
    // A fork inherits its parent's compaction records, so a compaction really
    // can sit before the child's first native turn. Silently drawing it at
    // turn 0 would claim it happened inside this session.
    expect(placeCompactions(turns, [C(50)])[0].i).toBe(-1);
  });

  it("handles an empty session without scanning off the end", () => {
    expect(placeCompactions([], [C(100)])[0].i).toBe(-1);
  });

  it("returns them in axis order", () => {
    const out = placeCompactions(turns, [C(300), C(150)]);
    expect(out.map((c) => c.i)).toEqual([0, 2]);
  });
});

describe("gaps", () => {
  it("finds the pauses longer than the threshold", () => {
    const turns = [T({ ts: 0 }), T({ ts: 1000 }), T({ ts: 100_000 })];
    expect(gaps(turns, 10_000)).toEqual([{ i: 1, ms: 99_000 }]);
  });

  it("indexes the turn BEFORE the gap, so the rule falls between bars", () => {
    const turns = [T({ ts: 0 }), T({ ts: 500_000 })];
    expect(gaps(turns, 1000)[0].i).toBe(0);
  });

  it("has nothing to say about a session of one turn", () => {
    expect(gaps([T({ ts: 0 })], 1)).toEqual([]);
  });
});

describe("summarise", () => {
  it("compares the first fifth against the last", () => {
    // 10 turns: the first five cost $1, the last five $3.
    const turns = [
      ...Array.from({ length: 5 }, (_, i) => T({ ts: i, costTotal: 1 })),
      ...Array.from({ length: 5 }, (_, i) => T({ ts: 5 + i, costTotal: 3 })),
    ];
    const s = summarise(turns);
    expect(s.turns).toBe(10);
    expect(s.cost).toBe(20);
    expect(s.firstFifthMean).toBe(1); // fifth of 10 = 2 turns
    expect(s.lastFifthMean).toBe(3);
  });

  it("excludes subagent turns from the growth means and the peak", () => {
    // A subagent's context is its own; counting it would make the session's
    // context look like it collapsed every time an agent ran.
    const turns = [
      T({ ts: 1, costTotal: 1, contextTokens: 500_000 }),
      T({ ts: 2, costTotal: 99, contextTokens: 9_000_000, context: "subagent" }),
      T({ ts: 3, costTotal: 1, contextTokens: 600_000 }),
    ];
    const s = summarise(turns);
    expect(s.subagentTurns).toBe(1);
    expect(s.peakContextTokens).toBe(600_000);
    expect(s.cost).toBe(101); // cost still counts every turn — it was all billed
    expect(s.firstFifthMean).toBe(1);
    expect(s.lastFifthMean).toBe(1);
  });

  it("survives a session with no main-loop turns", () => {
    const s = summarise([T({ ts: 1, costTotal: 5, context: "subagent" })]);
    expect(s.firstFifthMean).toBe(0);
    expect(s.lastFifthMean).toBe(0);
    expect(s.peakContextTokens).toBe(0);
    expect(s.cost).toBe(5);
  });

  it("is empty-safe", () => {
    expect(summarise([])).toEqual({
      turns: 0,
      cost: 0,
      firstFifthMean: 0,
      lastFifthMean: 0,
      peakContextTokens: 0,
      subagentTurns: 0,
    });
  });
});
