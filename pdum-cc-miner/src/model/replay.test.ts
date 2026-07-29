/**
 * The replay's pure model. The fixtures mirror shapes the real transcript
 * produces — a result far from its call, a fork's orphaned answer, a session
 * whose work occupies a few hours of a week-long span.
 */

import { describe, expect, it } from "vitest";
import { agentTracks, fold, hourBuckets, type ReplayRow, withinHour } from "./replay";

let seq = 0;
const R = (o: Partial<ReplayRow>): ReplayRow => ({
  seq: seq++,
  ts: 0,
  agentId: null,
  context: "main",
  uuid: null,
  parentUuid: null,
  role: "assistant",
  kind: "text",
  text: null,
  truncated: false,
  fullChars: 0,
  toolName: null,
  toolUseId: null,
  ok: null,
  errorKind: null,
  exitCode: null,
  durationMs: null,
  model: null,
  ...o,
});

describe("fold", () => {
  it("folds a tool_result into the tool_use it answers", () => {
    seq = 0;
    const out = fold([
      R({ kind: "tool_use", toolName: "Bash", toolUseId: "t1", text: "git status" }),
      R({ kind: "tool_result", toolUseId: "t1", text: "clean", ok: true, durationMs: 320 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("tool_use");
    expect(out[0].result?.text).toBe("clean");
    expect(out[0].result?.durationMs).toBe(320);
    expect(out[0].failed).toBe(false);
  });

  it("matches by id, not adjacency — a background tool answers much later", () => {
    seq = 0;
    const out = fold([
      R({ kind: "tool_use", toolName: "Bash", toolUseId: "slow", text: "pnpm build" }),
      R({ kind: "tool_use", toolName: "Read", toolUseId: "fast", text: "a.ts" }),
      R({ kind: "tool_result", toolUseId: "fast", text: "contents", ok: true }),
      R({ kind: "text", text: "meanwhile…" }),
      R({ kind: "tool_result", toolUseId: "slow", text: "built", ok: true }),
    ]);
    const byTool = new Map(out.map((o) => [o.toolUseId, o]));
    expect(byTool.get("slow")?.result?.text).toBe("built");
    expect(byTool.get("fast")?.result?.text).toBe("contents");
  });

  it("marks a failure from either signal", () => {
    seq = 0;
    const viaOk = fold([
      R({ kind: "tool_use", toolUseId: "a", toolName: "Bash" }),
      R({ kind: "tool_result", toolUseId: "a", ok: false, errorKind: "boom" }),
    ]);
    expect(viaOk[0].failed).toBe(true);
    seq = 0;
    const viaExit = fold([
      R({ kind: "tool_use", toolUseId: "b", toolName: "Bash" }),
      R({ kind: "tool_result", toolUseId: "b", exitCode: 1 }),
    ]);
    expect(viaExit[0].failed).toBe(true);
  });

  it("keeps a result whose call is missing rather than dropping it", () => {
    // A fork's copied prefix can contain the answer but not the question.
    // Dropping it would leave a hole in the transcript with no explanation.
    seq = 0;
    const out = fold([R({ kind: "tool_result", toolUseId: "orphan", text: "…", ok: true })]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("tool_result");
  });

  it("leaves a tool_use with no answer visible and unmarked", () => {
    seq = 0;
    const out = fold([R({ kind: "tool_use", toolUseId: "pending", toolName: "Bash" })]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBeUndefined();
    expect(out[0].failed).toBe(false);
  });

  it("returns items in seq order", () => {
    seq = 0;
    const rows = [
      R({ kind: "prompt", text: "do it" }),
      R({ kind: "tool_use", toolUseId: "t", toolName: "Bash" }),
      R({ kind: "tool_result", toolUseId: "t", ok: true }),
      R({ kind: "text", text: "done" }),
    ];
    expect(fold(rows).map((o) => o.seq)).toEqual([0, 1, 3]);
  });
});

const HOUR = 3600_000;

describe("hourBuckets", () => {
  it("counts blocks, prompts, tool calls and failures per hour", () => {
    seq = 0;
    const items = fold([
      R({ ts: HOUR * 10, kind: "prompt" }),
      R({ ts: HOUR * 10 + 60_000, kind: "tool_use", toolUseId: "a", toolName: "Bash" }),
      R({ ts: HOUR * 10 + 61_000, kind: "tool_result", toolUseId: "a", ok: false }),
      R({ ts: HOUR * 12, kind: "text" }),
    ]);
    const b = hourBuckets(items);
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ hour: HOUR * 10, prompts: 1, toolCalls: 1, failures: 1 });
    expect(b[1]).toMatchObject({ hour: HOUR * 12, blocks: 1, failures: 0 });
  });

  it("omits the empty hours between bursts of work", () => {
    // A session spans days while its work occupies hours — the priciest one in
    // this corpus is 92% idle. Drawing every empty hour is not navigation.
    seq = 0;
    const items = fold([R({ ts: HOUR * 1, kind: "text" }), R({ ts: HOUR * 200, kind: "text" })]);
    expect(hourBuckets(items).map((b) => b.hour)).toEqual([HOUR, HOUR * 200]);
  });

  it("skips blocks with no timestamp rather than bucketing them at 1970", () => {
    seq = 0;
    expect(hourBuckets(fold([R({ ts: 0, kind: "text" })]))).toEqual([]);
  });
});

describe("withinHour", () => {
  it("takes exactly the hour asked for", () => {
    seq = 0;
    const items = fold([
      R({ ts: HOUR * 5 - 1, kind: "text" }),
      R({ ts: HOUR * 5, kind: "text" }),
      R({ ts: HOUR * 6 - 1, kind: "text" }),
      R({ ts: HOUR * 6, kind: "text" }),
    ]);
    expect(withinHour(items, HOUR * 5)).toHaveLength(2);
    expect(withinHour(items, null)).toHaveLength(4);
  });
});

describe("agentTracks", () => {
  it("puts the main loop first, then agents by volume", () => {
    seq = 0;
    const items = fold([
      R({ agentId: "a1", context: "subagent" }),
      R({ agentId: "a1", context: "subagent" }),
      R({ agentId: null }),
      R({ agentId: "a2", context: "subagent" }),
    ]);
    const t = agentTracks(items);
    expect(t[0].agentId).toBeNull();
    expect(t.slice(1).map((x) => x.agentId)).toEqual(["a1", "a2"]);
    expect(t[1].blocks).toBe(2);
  });
});
