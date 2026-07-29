/**
 * These tests pin the four traps from `fields.ts`. Each one is a bug that was
 * either found in a real corpus or shipped in this package and caught later —
 * so each fixture is a miniature of the real failure, not a hypothetical.
 */

import { describe, expect, it } from "vitest";
import {
  agentNameOf,
  billableUnits,
  billingKey,
  isInherited,
  originSession,
  splitModel,
} from "./fields.ts";
import { estimateImageTokens, imageDims, pngDims } from "./images.ts";
import { checkInvariants, Normalizer } from "./normalize.ts";
import type { PriceTable } from "./pricing.ts";
import { priceUnit } from "./pricing.ts";
import type { TranscriptFile } from "./scan.ts";
import { projectLabel } from "./scan.ts";

const PRICES: PriceTable = {
  version: "test",
  source: "litellm",
  entries: {
    "model-a": {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 10e-6,
      cache_creation_input_token_cost: 2e-6,
      cache_creation_input_token_cost_above_1hr: 3.2e-6,
      cache_read_input_token_cost: 0.1e-6,
    },
    "model-b": { input_cost_per_token: 5e-6, output_cost_per_token: 50e-6 },
  },
};

const FILE = (
  sessionId: string,
  kind: TranscriptFile["kind"] = "session",
  extra: Partial<TranscriptFile> = {},
): TranscriptFile => ({
  path: `/x/${sessionId}${kind === "session" ? ".jsonl" : "/subagents/a.jsonl"}`,
  projectSlug: "-Users-x-proj",
  fileSessionId: sessionId,
  kind,
  bytes: 0,
  ...extra,
});

/** A session file with a birthtime — lineage needs one to break a tie. */
const BORN = (sessionId: string, iso: string): TranscriptFile =>
  FILE(sessionId, "session", { createdMs: Date.parse(iso) });

const usage = (o: Partial<Record<string, number>> = {}) => ({
  input_tokens: o.input ?? 10,
  output_tokens: o.output ?? 100,
  cache_creation_input_tokens: (o.c5 ?? 0) + (o.c1 ?? 0),
  cache_read_input_tokens: o.cr ?? 0,
  cache_creation: {
    ephemeral_5m_input_tokens: o.c5 ?? 0,
    ephemeral_1h_input_tokens: o.c1 ?? 0,
  },
});

/** One assistant record — the per-block shape Claude Code actually writes. */
const assistantRec = (o: {
  id: string;
  uuid: string;
  session: string;
  originSession?: string;
  block?: unknown;
  req?: string;
  usageOverride?: unknown;
  model?: string;
  ts?: string;
}) => ({
  type: "assistant",
  uuid: o.uuid,
  requestId: o.req ?? `req_${o.id}`,
  sessionId: o.session,
  ...(o.originSession ? { session_id: o.originSession } : {}),
  timestamp: o.ts ?? "2026-07-01T00:00:00.000Z",
  cwd: "/Users/x/proj",
  version: "2.1.220",
  message: {
    id: o.id,
    model: o.model ?? "model-a",
    stop_reason: "end_turn",
    content: [o.block ?? { type: "text", text: "hi" }],
    usage: o.usageOverride ?? usage(),
  },
});

describe("trap: per-block record duplication", () => {
  it("counts one response's usage once, but unions its content blocks", () => {
    const n = new Normalizer({ pricing: PRICES });
    const f = FILE("s1");
    // ONE API response, written as THREE records, each repeating the usage.
    n.add(
      assistantRec({
        id: "m1",
        uuid: "u1",
        session: "s1",
        block: { type: "thinking", thinking: "abcd" },
      }),
      f,
    );
    n.add(
      assistantRec({ id: "m1", uuid: "u2", session: "s1", block: { type: "text", text: "hello" } }),
      f,
    );
    n.add(
      assistantRec({
        id: "m1",
        uuid: "u3",
        session: "s1",
        block: { type: "tool_use", id: "t1", name: "Bash", input: {} },
      }),
      f,
    );
    const out = n.finish();

    expect(out.turns).toHaveLength(1);
    // usage counted ONCE, not three times
    expect(out.turns[0].outputTokens).toBe(100);
    // ...but every block survives — dedup for billing must not dedup structure
    expect(out.turns[0].nBlocks).toBe(3);
    expect(out.turns[0].nThinkingChars).toBe(4);
    expect(out.turns[0].nToolUses).toBe(1);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].toolName).toBe("Bash");
  });
});

describe("trap: partial usage inside a billing group", () => {
  it("takes the member with the real output, not the first one", () => {
    // The exact shape found in subagent transcripts: cache_read constant across
    // the group, output_tokens a placeholder until the final record.
    const n = new Normalizer({ pricing: PRICES });
    const f = FILE("s1", "subagent");
    const partial = (uuid: string, out: number, block: unknown) =>
      assistantRec({
        id: "m1",
        uuid,
        session: "s1",
        block,
        usageOverride: {
          input_tokens: 3,
          output_tokens: out,
          cache_read_input_tokens: 156614,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      });
    n.add(partial("u1", 5, { type: "thinking", thinking: "x" }), f);
    n.add(partial("u2", 5, { type: "text", text: "y" }), f);
    n.add(partial("u3", 48469, { type: "tool_use", id: "t1", name: "Bash", input: {} }), f);

    const out = n.finish();
    expect(out.turns).toHaveLength(1);
    // 48469, not 5 — taking the first member undercounted output by 32% corpus-wide
    expect(out.turns[0].outputTokens).toBe(48469);
    // the constant classes are unaffected, whichever member is chosen
    expect(out.turns[0].cacheReadTokens).toBe(156614);
    // structure is still unioned across all three records
    expect(out.turns[0].nBlocks).toBe(3);
    expect(out.toolCalls).toHaveLength(1);
  });

  it("still prefers the non-sidechain copy when output ties (fork case)", () => {
    const n = new Normalizer({ pricing: PRICES });
    n.add(assistantRec({ id: "m1", uuid: "u1", session: "s1", originSession: "s1" }), FILE("s1"));
    n.add(
      assistantRec({ id: "m1", uuid: "u1", session: "s2", originSession: "s1" }),
      FILE("s2", "subagent"),
    );
    const out = n.finish();
    expect(out.turns).toHaveLength(1);
    // attributed to the session that produced it, not the file it was copied into
    expect(out.turns[0].sessionId).toBe("s1");
  });
});

describe("trap: fork copies the prefix", () => {
  it("counts a turn once when it appears in two session files", () => {
    const n = new Normalizer({ pricing: PRICES });
    // The original, in its own session.
    n.add(assistantRec({ id: "m1", uuid: "u1", session: "s1", originSession: "s1" }), FILE("s1"));
    // The fork's copy: same uuid/message.id, sessionId rewritten, session_id kept.
    n.add(assistantRec({ id: "m1", uuid: "u1", session: "s2", originSession: "s1" }), FILE("s2"));
    // A turn the fork actually produced.
    n.add(assistantRec({ id: "m2", uuid: "u2", session: "s2", originSession: "s2" }), FILE("s2"));

    const out = n.finish();
    expect(out.turns).toHaveLength(2);
    expect(out.stats.crossFileDuplicates).toBe(1);

    // The inherited turn is credited to s1, which produced it — not to s2.
    const bySession = new Map(out.sessions.map((s) => [s.sessionId, s]));
    expect(bySession.get("s1")?.nTurnsNative).toBe(1);
    expect(bySession.get("s2")?.nTurnsNative).toBe(1);
    expect(checkInvariants(out).ok).toBe(true);
  });

  it("does not double-count a fork copy's content blocks", () => {
    const n = new Normalizer({ pricing: PRICES });
    const block = { type: "tool_use", id: "t1", name: "Read", input: {} };
    n.add(assistantRec({ id: "m1", uuid: "u1", session: "s1", block }), FILE("s1"));
    n.add(
      assistantRec({ id: "m1", uuid: "u1", session: "s2", originSession: "s1", block }),
      FILE("s2"),
    );
    const out = n.finish();
    expect(out.turns[0].nToolUses).toBe(1);
    expect(out.toolCalls).toHaveLength(1);
  });

  it("reads session_id as provenance, not as an alias of sessionId", () => {
    expect(isInherited({ sessionId: "b", session_id: "a" })).toBe(true);
    expect(isInherited({ sessionId: "a", session_id: "a" })).toBe(false);
    // Pre-2.1.199 records have no session_id at all — not decidable, not inherited.
    expect(isInherited({ sessionId: "a" })).toBe(false);
    expect(originSession({ sessionId: "b", session_id: "a" })).toBe("a");
    expect(originSession({ sessionId: "b" })).toBe("b");
  });
});

describe("trap: fallback iterations", () => {
  it("prices the discarded attempt, which top-level usage omits", () => {
    const rec = assistantRec({
      id: "m1",
      uuid: "u1",
      session: "s1",
      model: "model-b",
      usageOverride: {
        ...usage({ output: 5000 }),
        // top level reflects only the LAST attempt…
        iterations: [
          { type: "message", model: "model-a", input_tokens: 10, output_tokens: 250 },
          { type: "fallback_message", model: "model-b", input_tokens: 10, output_tokens: 5000 },
        ],
      },
    });
    const units = billableUnits(rec);
    expect(units).toHaveLength(2);
    expect(units[0].model).toBe("model-a");
    expect(units[1].model).toBe("model-b");

    const n = new Normalizer({ pricing: PRICES });
    n.add(rec, FILE("s1"));
    const out = n.finish();
    // 250 + 5000, not just the 5000 the top level advertises
    expect(out.turns[0].outputTokens).toBe(5250);
    expect(out.turns[0].hadFallback).toBe(true);
    expect(out.turns[0].wastedOutputTokens).toBe(250);
  });
});

describe("pricing", () => {
  it("charges the 1h cache tier above the 5m rate", () => {
    const flat = priceUnit(PRICES, {
      model: "model-a",
      input: 0,
      output: 0,
      cacheCreate: 1000,
      cacheRead: 0,
      cache5m: 1000,
      cache1h: 0,
      webSearches: 0,
      webFetches: 0,
    });
    const tiered = priceUnit(PRICES, {
      model: "model-a",
      input: 0,
      output: 0,
      cacheCreate: 1000,
      cacheRead: 0,
      cache5m: 0,
      cache1h: 1000,
      webSearches: 0,
      webFetches: 0,
    });
    expect(flat?.cacheCreate).toBeCloseTo(0.002);
    expect(tiered?.cacheCreate).toBeCloseTo(0.0032);
    // The 1.6x gap is the whole reason this package does not use genai-prices.
    expect((tiered?.cacheCreate ?? 0) / (flat?.cacheCreate ?? 1)).toBeCloseTo(1.6);
  });

  it("never prices a synthetic model", () => {
    expect(
      priceUnit(PRICES, {
        model: "<synthetic>",
        input: 1e6,
        output: 1e6,
        cacheCreate: 0,
        cacheRead: 0,
        cache5m: 0,
        cache1h: 0,
        webSearches: 0,
        webFetches: 0,
      }),
    ).toBeUndefined();
  });

  it("keeps a bracketed context variant distinct from its base model", () => {
    expect(splitModel("claude-opus-4-8[1m]")).toEqual({ base: "claude-opus-4-8", variant: "1m" });
    expect(splitModel("claude-opus-4-8")).toEqual({ base: "claude-opus-4-8", variant: undefined });
  });

  it("falls back to the aggregate when a build predates the TTL split", () => {
    const n = new Normalizer({ pricing: PRICES });
    n.add(
      assistantRec({
        id: "m1",
        uuid: "u1",
        session: "s1",
        // no `cache_creation` object at all — the pre-split shape
        usageOverride: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 500 },
      }),
      FILE("s1"),
    );
    const out = n.finish();
    // Those tokens stay visible rather than vanishing into an absent TTL bucket.
    expect(out.turns[0].cacheCreate5m).toBe(500);
    expect(out.turns[0].costCacheCreate).toBeCloseTo(0.001);
  });
});

describe("billing key", () => {
  it("separates records that share a message.id but differ in requestId", () => {
    const a = billingKey({ message: { id: "m1" }, requestId: "r1" });
    const b = billingKey({ message: { id: "m1" }, requestId: "r2" });
    expect(a).not.toBe(b);
    expect(billingKey({ message: {} })).toBeUndefined();
  });
});

describe("images", () => {
  it("reads PNG dimensions from the IHDR header alone", () => {
    // 8-byte signature, then a length+"IHDR" chunk with width/height.
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    b.set([0x49, 0x48, 0x44, 0x52], 12);
    new DataView(b.buffer).setUint32(16, 2000);
    new DataView(b.buffer).setUint32(20, 966);
    expect(pngDims(b)).toEqual({ width: 2000, height: 966 });
    expect(imageDims("image/png", b)).toEqual({ width: 2000, height: 966 });
    // Anthropic's published approximation.
    expect(estimateImageTokens({ width: 2000, height: 966 })).toBe(2576);
  });

  it("returns undefined rather than throwing on a non-image buffer", () => {
    expect(pngDims(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(imageDims("image/png", new Uint8Array(0))).toBeUndefined();
  });
});

describe("leniency", () => {
  it("survives records that violate every expectation", () => {
    const n = new Normalizer({ pricing: PRICES });
    const f = FILE("s1");
    expect(() => {
      n.add({}, f);
      n.add({ type: "assistant" }, f);
      n.add({ type: "assistant", message: null }, f);
      n.add({ type: "assistant", message: { id: "m9", usage: "not-an-object" } }, f);
      n.add({ type: "user", toolUseResult: "a string, not an object" }, f);
      n.add({ type: "user", message: { content: "not an array" } }, f);
      n.add({ type: "system", compactMetadata: 42 }, f);
      n.add({ type: "brand-new-record-type-from-a-future-build", wat: true }, f);
    }).not.toThrow();
    const out = n.finish();
    expect(checkInvariants(out).ok).toBe(true);
  });
});

describe("sessions", () => {
  it("separates wall-clock span from active time", () => {
    const n = new Normalizer({ pricing: PRICES, idleGapSeconds: 1800 });
    const f = FILE("s1");
    // two turns a minute apart, then a 5-hour gap, then one more
    n.add(assistantRec({ id: "m1", uuid: "u1", session: "s1", ts: "2026-07-01T00:00:00.000Z" }), f);
    n.add(assistantRec({ id: "m2", uuid: "u2", session: "s1", ts: "2026-07-01T00:01:00.000Z" }), f);
    n.add(assistantRec({ id: "m3", uuid: "u3", session: "s1", ts: "2026-07-01T05:01:00.000Z" }), f);
    const [s] = n.finish().sessions;
    expect(s.spanSeconds).toBeCloseTo(5 * 3600 + 60);
    expect(s.activeSeconds).toBeCloseTo(60); // the 5h gap is idle, not work
    expect(s.dutyCycle).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// names — see fields.ts on why these records are unlike every other kind
// ---------------------------------------------------------------------------

/** Naming records carry no timestamp and no uuid; file order is all there is. */
const nameRec = (type: string, field: string, value: string, session = "s1") => ({
  type,
  [field]: value,
  sessionId: session,
});

describe("session names", () => {
  const turn = (f: TranscriptFile, n: Normalizer, i = 1) =>
    n.add(
      assistantRec({ id: `m${i}`, uuid: `u${i}`, session: "s1", ts: "2026-07-01T00:00:00.000Z" }),
      f,
    );

  it("takes the last value as the name and the first as the stable one", () => {
    const n = new Normalizer({ pricing: PRICES });
    const f = FILE("s1");
    turn(f, n);
    // Re-emitted many times, as the real format does — 444 records for 3 values
    // in the widest case. The reduction must be on distinct values, not count.
    n.add(nameRec("custom-title", "customTitle", "dsl-fork-point"), f);
    n.add(nameRec("custom-title", "customTitle", "dsl-fork-point"), f);
    n.add(nameRec("custom-title", "customTitle", "march"), f);

    const [s] = n.finish().sessions;
    expect(s.name).toBe("march"); // what the user calls it now
    expect(s.nameFirst).toBe("dsl-fork-point"); // what a note from last month says
    expect(s.nameChanged).toBe(true);
    expect(s.customTitleFirst).toBe("dsl-fork-point");
  });

  it("omits the -First columns when nothing changed", () => {
    const n = new Normalizer({ pricing: PRICES });
    const f = FILE("s1");
    turn(f, n);
    n.add(nameRec("custom-title", "customTitle", "pencil"), f);
    n.add(nameRec("custom-title", "customTitle", "pencil"), f);

    const [s] = n.finish().sessions;
    expect(s.name).toBe("pencil");
    expect(s.nameChanged).toBe(false);
    expect(s.customTitleFirst).toBeUndefined();
  });

  it("prefers an explicit name over an AI title over the slug", () => {
    const n = new Normalizer({ pricing: PRICES });
    const f = FILE("s1");
    n.add(
      {
        ...assistantRec({ id: "m1", uuid: "u1", session: "s1", ts: "2026-07-01T00:00:00.000Z" }),
        slug: "abstract-wiggling-aho",
      },
      f,
    );
    n.add(nameRec("ai-title", "aiTitle", "Review ink package iPad backend"), f);
    expect(n.finish().sessions[0].name).toBe("Review ink package iPad backend");

    const m = new Normalizer({ pricing: PRICES });
    const g = FILE("s1");
    turn(g, m);
    m.add(nameRec("ai-title", "aiTitle", "Review ink package iPad backend"), g);
    m.add(nameRec("custom-title", "customTitle", "pencil"), g);
    const [s] = m.finish().sessions;
    expect(s.name).toBe("pencil");
    expect(s.nameKind).toBe("explicit");
    expect(s.aiTitle).toBe("Review ink package iPad backend"); // still available
  });

  it("treats agent-name as an alias of custom-title", () => {
    // The two are written as a pair and never disagreed across the corpus, but
    // 4 sessions carry agent-name alone — taking custom-title only loses them.
    const n = new Normalizer({ pricing: PRICES });
    const f = FILE("s1");
    turn(f, n);
    n.add(nameRec("agent-name", "agentName", "rfb-publish"), f);
    const [s] = n.finish().sessions;
    expect(s.name).toBe("rfb-publish");
    expect(s.nameKind).toBe("explicit");
  });

  it("always labels a session, falling back to the id", () => {
    const n = new Normalizer({ pricing: PRICES });
    const f = FILE("abcdef12-3456-7890-abcd-ef1234567890");
    n.add(
      assistantRec({
        id: "m1",
        uuid: "u1",
        session: "abcdef12-3456-7890-abcd-ef1234567890",
        ts: "2026-07-01T00:00:00.000Z",
      }),
      f,
    );
    const [s] = n.finish().sessions;
    expect(s.name).toBe("abcdef12");
    expect(s.nameKind).toBe("id");
    expect(s.nameChanged).toBe(false);
  });

  it("reads an agent's name out of its id, and marks a fork as not-a-name", () => {
    expect(agentNameOf("abar-channel-71b78c98767d31e4")).toEqual({
      name: "bar-channel",
      kind: "named",
    });
    // A fork's label is built from the prompt's opening words; it reads like a
    // name but the user did not choose it, so a UI must not present it as one.
    expect(agentNameOf("awhere-is-the-1da17ee1af061e5a", "fork")).toEqual({
      name: "where-is-the",
      kind: "fork",
    });
    expect(agentNameOf("a18d7d29490a075c2")).toEqual({ kind: "anonymous" });
    expect(agentNameOf(undefined)).toEqual({ kind: "anonymous" });
  });
});

// ---------------------------------------------------------------------------
// fork lineage — the session-graph grain
// ---------------------------------------------------------------------------

/** A non-assistant record, since a fork copies those too and they carry uuids. */
const plainRec = (o: {
  type: string;
  uuid: string;
  session: string;
  origin?: string;
  ts: string;
}) => ({
  type: o.type,
  uuid: o.uuid,
  sessionId: o.session,
  ...(o.origin ? { session_id: o.origin } : {}),
  timestamp: o.ts,
  cwd: "/Users/x/proj",
});

/**
 * Replay a session's records into a fork's file the way Claude Code does:
 * same uuid, same timestamp, `sessionId` rewritten, `session_id` preserved.
 */
const copyInto = (recs: Record<string, unknown>[], child: string, marked: boolean) =>
  recs.map((r) => ({
    ...r,
    sessionId: child,
    ...(marked ? { session_id: (r.session_id as string) ?? (r.sessionId as string) } : {}),
  }));

describe("fork lineage", () => {
  it("finds the edge, the fork point, and the child's own start", () => {
    const n = new Normalizer({ pricing: PRICES });
    const parentRecs = [
      assistantRec({ id: "m1", uuid: "u1", session: "p", ts: "2026-07-01T00:00:00.000Z" }),
      assistantRec({ id: "m2", uuid: "u2", session: "p", ts: "2026-07-01T00:05:00.000Z" }),
      assistantRec({ id: "m3", uuid: "u3", session: "p", ts: "2026-07-01T00:10:00.000Z" }),
    ];
    for (const r of parentRecs) n.add(r, BORN("p", "2026-07-01T00:00:00.000Z"));
    // The fork copies the first two turns, then works on its own — three days
    // later, which is the case the timeline has to be able to draw.
    const childFile = BORN("c", "2026-07-04T09:00:00.000Z");
    for (const r of copyInto(parentRecs.slice(0, 2), "c", true)) n.add(r, childFile);
    n.add(
      assistantRec({
        id: "m9",
        uuid: "u9",
        session: "c",
        originSession: "c",
        ts: "2026-07-04T09:00:10.000Z",
      }),
      childFile,
    );

    const out = n.finish();
    expect(out.forkEdges).toHaveLength(1);
    const [e] = out.forkEdges;
    expect(e.parentSessionId).toBe("p");
    expect(e.childSessionId).toBe("c");
    expect(e.kind).toBe("copy");
    expect(e.source).toBe("marker");
    expect(e.nRecordsInherited).toBe(2);
    expect(e.nTurnsInherited).toBe(2);
    // The bezier's two endpoints: where it left the parent, where the child began.
    expect(new Date(e.forkPointTs).toISOString()).toBe("2026-07-01T00:05:00.000Z");
    expect(new Date(e.childFirstNativeTs).toISOString()).toBe("2026-07-04T09:00:10.000Z");
    expect(e.lagSeconds).toBeCloseTo(3 * 86400 + 9 * 3600 + 10 - 5 * 60);

    const byId = new Map(out.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get("p")?.nTurnsNative).toBe(3);
    expect(byId.get("c")?.nTurnsNative).toBe(1);
    expect(byId.get("c")?.depth).toBe(1);
    expect(byId.get("c")?.lineageId).toBe("p");
    expect(byId.get("p")?.lineageId).toBe("p");
    expect(out.lineages).toHaveLength(1);
    expect(out.lineages[0].nSessions).toBe(2);
    expect(checkInvariants(out).ok).toBe(true);
  });

  it("recovers the edge from uuid overlap alone when the build wrote no marker", () => {
    // Pre-2.1.199: no `session_id` anywhere. Direction comes from shape — the
    // parent compacted one record away, so its copy of the shared block is not
    // its own leading prefix, and only an original can look like that.
    const n = new Normalizer({ pricing: PRICES });
    const head = plainRec({
      type: "user",
      uuid: "h",
      session: "p",
      ts: "2026-07-01T00:00:00.000Z",
    });
    const dropped = plainRec({
      type: "user",
      uuid: "x",
      session: "p",
      ts: "2026-07-01T00:01:00.000Z",
    });
    const kept = assistantRec({
      id: "m1",
      uuid: "u1",
      session: "p",
      ts: "2026-07-01T00:02:00.000Z",
    });

    // `c` before `p`, because that is the order the scanner walks them in — and
    // it means the FORK's copy of the shared turn is the one dedup keeps, which
    // is exactly when attribution has to be corrected rather than lucky.
    const c = FILE("c");
    for (const r of copyInto([head, kept], "c", false)) n.add(r, c);
    n.add(assistantRec({ id: "m3", uuid: "u3", session: "c", ts: "2026-07-01T01:00:00.000Z" }), c);

    const p = FILE("p");
    for (const r of [head, dropped, kept]) n.add(r, p);
    n.add(assistantRec({ id: "m2", uuid: "u2", session: "p", ts: "2026-07-01T00:03:00.000Z" }), p);

    const out = n.finish();
    expect(out.forkEdges).toHaveLength(1);
    expect(out.forkEdges[0]).toMatchObject({
      parentSessionId: "p",
      childSessionId: "c",
      source: "uuid-overlap",
      ambiguous: false,
      kind: "copy",
    });
    // And the payoff: the inherited turn is credited to p, not to the file that
    // merely carries it. Without this the fork's lane would start an hour early.
    const byId = new Map(out.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get("p")?.nTurnsNative).toBe(2);
    expect(byId.get("c")?.nTurnsNative).toBe(1);
    expect(byId.get("c")?.nTurnsInherited).toBe(1);
    expect(out.stats.reattributedTurns).toBe(1);
    expect(new Date(byId.get("c")?.firstNativeTs ?? 0).toISOString()).toBe(
      "2026-07-01T01:00:00.000Z",
    );
    expect(checkInvariants(out).ok).toBe(true);
  });

  it("breaks a symmetric prefix by file creation order, and says it did", () => {
    // Nothing was dropped, so both files hold the shared records as their own
    // leading prefix and content cannot tell copy from original.
    const n = new Normalizer({ pricing: PRICES });
    const shared = [
      plainRec({ type: "user", uuid: "h", session: "p", ts: "2026-07-01T00:00:00.000Z" }),
      assistantRec({ id: "m1", uuid: "u1", session: "p", ts: "2026-07-01T00:01:00.000Z" }),
    ];
    const p = BORN("p", "2026-07-01T00:00:00.000Z");
    for (const r of shared) n.add(r, p);
    n.add(assistantRec({ id: "m2", uuid: "u2", session: "p", ts: "2026-07-01T00:09:00.000Z" }), p);

    const c = BORN("c", "2026-07-01T00:05:00.000Z");
    for (const r of copyInto(shared, "c", false)) n.add(r, c);
    n.add(assistantRec({ id: "m3", uuid: "u3", session: "c", ts: "2026-07-01T00:06:00.000Z" }), c);

    const out = n.finish();
    expect(out.forkEdges).toHaveLength(1);
    expect(out.forkEdges[0].parentSessionId).toBe("p");
    // Flagged, because a widget must not draw a guess like a proof.
    expect(out.forkEdges[0].ambiguous).toBe(true);
    expect(out.stats.forkEdgesAmbiguous).toBe(1);
  });

  it("refuses to guess when nothing can break the tie", () => {
    const n = new Normalizer({ pricing: PRICES });
    const shared = [
      plainRec({ type: "user", uuid: "h", session: "p", ts: "2026-07-01T00:00:00.000Z" }),
      assistantRec({ id: "m1", uuid: "u1", session: "p", ts: "2026-07-01T00:01:00.000Z" }),
    ];
    for (const r of shared) n.add(r, FILE("p")); // no birthtime on either file
    n.add(
      assistantRec({ id: "m2", uuid: "u2", session: "p", ts: "2026-07-01T00:09:00.000Z" }),
      FILE("p"),
    );
    for (const r of copyInto(shared, "c", false)) n.add(r, FILE("c"));
    n.add(
      assistantRec({ id: "m3", uuid: "u3", session: "c", ts: "2026-07-01T00:06:00.000Z" }),
      FILE("c"),
    );

    const out = n.finish();
    expect(out.forkEdges).toHaveLength(0);
    expect(out.stats.unresolvedForks).toBeGreaterThan(0);
    // A gap is the honest answer; a wrong lineage drawn confidently is not.
    expect(out.sessions.every((s) => s.parentSessionId === undefined)).toBe(true);
  });

  it("lets content name a nearer parent than the marker does", () => {
    // The real shape from the corpus: 63baa90e → 4df4dbb9 → 70486150. The
    // records 4df4dbb9 added are `system`/`user` and carry no `session_id`, so
    // the last MARKED record in 70486150's file still names the grandparent.
    const n = new Normalizer({ pricing: PRICES });
    const gp = BORN("gp", "2026-07-01T00:00:00.000Z");
    const gpRecs = [
      plainRec({
        type: "user",
        uuid: "h",
        session: "gp",
        origin: "gp",
        ts: "2026-07-01T00:00:00.000Z",
      }),
      assistantRec({
        id: "m1",
        uuid: "u1",
        session: "gp",
        originSession: "gp",
        ts: "2026-07-01T00:01:00.000Z",
      }),
    ];
    for (const r of gpRecs) n.add(r, gp);

    const mid = BORN("mid", "2026-07-01T01:00:00.000Z");
    for (const r of copyInto(gpRecs, "mid", true)) n.add(r, mid);
    // mid's own contribution: an unmarked record type, exactly as observed.
    const midOwn = plainRec({
      type: "system",
      uuid: "s1",
      session: "mid",
      ts: "2026-07-01T01:00:05.000Z",
    });
    n.add(midOwn, mid);

    const kid = BORN("kid", "2026-07-01T02:00:00.000Z");
    for (const r of copyInto([...gpRecs, midOwn], "kid", true)) n.add(r, kid);
    n.add(
      assistantRec({
        id: "m2",
        uuid: "u2",
        session: "kid",
        originSession: "kid",
        ts: "2026-07-01T02:00:10.000Z",
      }),
      kid,
    );

    const out = n.finish();
    const byChild = new Map(out.forkEdges.map((e) => [e.childSessionId, e]));
    expect(byChild.get("mid")?.parentSessionId).toBe("gp");
    // The marker on kid's last marked record still says "gp"; content says mid.
    expect(byChild.get("kid")?.parentSessionId).toBe("mid");
    expect(new Map(out.sessions.map((s) => [s.sessionId, s.depth])).get("kid")).toBe(2);
    expect(out.stats.maxForkDepth).toBe(2);
    expect(checkInvariants(out).ok).toBe(true);
  });

  it("anchors a grandchild to the nearest ancestor that has a bar to draw", () => {
    // The corpus shape: 63baa90e → 4df4dbb9 → {70486150, de93c3a5}, where the
    // MIDDLE session produced no billed turn. A timeline built by aggregating
    // `turns` has no bar for it, so three of ten edges vanish and the chain
    // breaks in half. `billedAncestor*` gives the two outgoing edges an anchor
    // that exists, without inventing an edge that never happened.
    const n = new Normalizer({ pricing: PRICES });
    const gp = BORN("gp", "2026-07-01T00:00:00.000Z");
    const gpRecs = [
      plainRec({ type: "user", uuid: "h", session: "gp", ts: "2026-07-01T00:00:00.000Z" }),
      assistantRec({ id: "m1", uuid: "u1", session: "gp", ts: "2026-07-01T00:01:00.000Z" }),
    ];
    for (const r of gpRecs) n.add(r, gp);

    // The middle: inherits everything, adds one un-billed record, stops.
    const mid = BORN("mid", "2026-07-01T01:00:00.000Z");
    for (const r of copyInto(gpRecs, "mid", false)) n.add(r, mid);
    const midOwn = plainRec({
      type: "system",
      uuid: "s1",
      session: "mid",
      ts: "2026-07-01T01:00:05.000Z",
    });
    n.add(midOwn, mid);

    const kid = BORN("kid", "2026-07-01T02:00:00.000Z");
    for (const r of copyInto([...gpRecs, midOwn], "kid", false)) n.add(r, kid);
    n.add(
      assistantRec({ id: "m2", uuid: "u2", session: "kid", ts: "2026-07-01T02:00:10.000Z" }),
      kid,
    );

    const out = n.finish();
    const byChild = new Map(out.forkEdges.map((e) => [e.childSessionId, e]));

    const midEdge = byChild.get("mid");
    expect(midEdge?.parentHasTurns).toBe(true);
    expect(midEdge?.childHasTurns).toBe(false); // nothing to hang a bar on

    const kidEdge = byChild.get("kid");
    expect(kidEdge?.parentSessionId).toBe("mid");
    expect(kidEdge?.parentHasTurns).toBe(false);
    // …so fall back to gp, at the point kid branched off *gp's* timeline.
    expect(kidEdge?.billedAncestorSessionId).toBe("gp");
    expect(new Date(kidEdge?.billedAncestorForkPointTs ?? 0).toISOString()).toBe(
      "2026-07-01T00:01:00.000Z",
    );
    // When the parent does have turns the anchor is just the parent — no
    // special case for a widget to write.
    expect(midEdge?.billedAncestorSessionId).toBe("gp");
    expect(midEdge?.billedAncestorForkPointTs).toBe(midEdge?.forkPointTs);
    expect(checkInvariants(out).ok).toBe(true);
  });

  it("calls a marked link with no copied records a continuation", () => {
    // Claude Code 2.1.220: every record carries `session_id` of an earlier
    // session, yet not one uuid is shared. Believing the marker would hand this
    // whole session's spend to its predecessor.
    const n = new Normalizer({ pricing: PRICES });
    const p = BORN("p", "2026-07-01T00:00:00.000Z");
    n.add(
      assistantRec({
        id: "m1",
        uuid: "u1",
        session: "p",
        originSession: "p",
        ts: "2026-07-01T00:00:00.000Z",
      }),
      p,
    );
    n.add(
      assistantRec({
        id: "m2",
        uuid: "u2",
        session: "p",
        originSession: "p",
        ts: "2026-07-01T01:00:00.000Z",
      }),
      p,
    );

    const c = BORN("c", "2026-07-01T01:06:00.000Z");
    n.add(
      assistantRec({
        id: "m3",
        uuid: "u3",
        session: "c",
        originSession: "p",
        ts: "2026-07-01T01:06:00.000Z",
      }),
      c,
    );

    const out = n.finish();
    expect(out.forkEdges).toHaveLength(1);
    expect(out.forkEdges[0]).toMatchObject({
      parentSessionId: "p",
      childSessionId: "c",
      kind: "continuation",
      nRecordsInherited: 0,
      nTurnsInherited: 0,
    });
    // The edge leaves the parent's END, not its middle.
    expect(new Date(out.forkEdges[0].forkPointTs).toISOString()).toBe("2026-07-01T01:00:00.000Z");
    const byId = new Map(out.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get("c")?.nTurnsNative).toBe(1);
    expect(byId.get("p")?.nTurnsNative).toBe(2);
    expect(checkInvariants(out).ok).toBe(true);
  });

  it("gives a fork that produced nothing a row anyway", () => {
    const n = new Normalizer({ pricing: PRICES });
    const p = BORN("p", "2026-07-01T00:00:00.000Z");
    const recs = [
      assistantRec({
        id: "m1",
        uuid: "u1",
        session: "p",
        originSession: "p",
        ts: "2026-07-01T00:00:00.000Z",
      }),
    ];
    for (const r of recs) n.add(r, p);
    const c = BORN("c", "2026-07-01T02:00:00.000Z");
    n.noteFile(c);
    for (const r of copyInto(recs, "c", true)) n.add(r, c);

    const out = n.finish();
    const child = out.sessions.find((s) => s.sessionId === "c");
    expect(child).toBeDefined();
    expect(child?.nTurnsNative).toBe(0);
    expect(child?.nativeCost).toBe(0);
    // With no activity of its own, its file birthtime is where it goes on a lane.
    expect(new Date(child?.createdTs ?? 0).toISOString()).toBe("2026-07-01T02:00:00.000Z");
    expect(checkInvariants(out).ok).toBe(true);
  });

  it("counts a compaction once even though the fork copied the record", () => {
    const n = new Normalizer({ pricing: PRICES });
    const compact = {
      type: "system",
      uuid: "sys1",
      sessionId: "p",
      session_id: "p",
      timestamp: "2026-07-01T00:02:00.000Z",
      compactMetadata: { trigger: "auto", preTokens: 120000, postTokens: 20000 },
    };
    const p = BORN("p", "2026-07-01T00:00:00.000Z");
    n.add(
      assistantRec({
        id: "m1",
        uuid: "u1",
        session: "p",
        originSession: "p",
        ts: "2026-07-01T00:01:00.000Z",
      }),
      p,
    );
    n.add(compact, p);
    const c = BORN("c", "2026-07-01T00:03:00.000Z");
    for (const r of copyInto(
      [
        assistantRec({
          id: "m1",
          uuid: "u1",
          session: "p",
          originSession: "p",
          ts: "2026-07-01T00:01:00.000Z",
        }),
        compact,
      ],
      "c",
      true,
    )) {
      n.add(r, c);
    }

    const out = n.finish();
    expect(out.events.filter((e) => e.kind === "compaction")).toHaveLength(1);
    expect(out.events[0].sessionId).toBe("p");
    const byId = new Map(out.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get("p")?.nCompactions).toBe(1);
    expect(byId.get("c")?.nCompactions).toBe(0);
    expect(byId.get("p")?.peakContextTokens).toBe(120000);
  });
});

describe("agent runs", () => {
  it("collapses a subagent's turns into one markable span", () => {
    const n = new Normalizer({ pricing: PRICES });
    const main = BORN("s1", "2026-07-01T00:00:00.000Z");
    n.add(
      assistantRec({ id: "m0", uuid: "u0", session: "s1", ts: "2026-07-01T00:00:00.000Z" }),
      main,
    );

    const agentFile: TranscriptFile = {
      path: "/x/s1/subagents/agent-aexplore-1.jsonl",
      projectSlug: "-Users-x-proj",
      fileSessionId: "s1",
      kind: "subagent",
      bytes: 0,
      agentId: "aexplore-1",
    };
    n.noteFile(agentFile);
    n.add(
      {
        type: "fork-context-ref",
        agentId: "aexplore-1",
        parentSessionId: "s1",
        parentLastUuid: "u0",
        contextLength: 191,
      },
      agentFile,
    );
    for (const [i, ts] of ["00:01:00", "00:02:00", "00:04:00"].entries()) {
      n.add(
        {
          ...assistantRec({
            id: `a${i}`,
            uuid: `au${i}`,
            session: "s1",
            ts: `2026-07-01T${ts}.000Z`,
          }),
          isSidechain: true,
          agentId: "aexplore-1",
          attributionAgent: "Explore",
        },
        agentFile,
      );
    }

    const out = n.finish();
    expect(out.agentRuns).toHaveLength(1);
    const [a] = out.agentRuns;
    expect(a).toMatchObject({
      agentId: "aexplore-1",
      agentType: "Explore",
      parentSessionId: "s1",
      context: "subagent",
      nTurns: 3,
      inheritedContextLength: 191,
      parentLastUuid: "u0",
    });
    expect(a.spanSeconds).toBeCloseTo(180);
    expect(a.cost).toBeCloseTo(3 * (10 * 1e-6 + 100 * 10e-6));
    // The launching session knows how many agents it ran.
    expect(out.sessions.find((s) => s.sessionId === "s1")?.nAgentRuns).toBe(1);
    expect(checkInvariants(out).ok).toBe(true);
  });

  it("keeps a workflow agent tagged with the workflow that spawned it", () => {
    const n = new Normalizer({ pricing: PRICES });
    const wfFile: TranscriptFile = {
      path: "/x/s1/subagents/workflows/wf_abc/agent-a1.jsonl",
      projectSlug: "-Users-x-proj",
      fileSessionId: "s1",
      kind: "workflow-agent",
      bytes: 0,
      agentId: "a1",
      workflowId: "wf_abc",
    };
    n.add(
      {
        ...assistantRec({ id: "w1", uuid: "wu1", session: "s1" }),
        isSidechain: true,
        agentId: "a1",
      },
      wfFile,
    );
    const out = n.finish();
    expect(out.agentRuns[0]).toMatchObject({ workflowId: "wf_abc", context: "workflow-agent" });
    expect(out.turns[0].workflowId).toBe("wf_abc");
  });
});

describe("invariants", () => {
  it("catches a lineage that does not close", () => {
    const ok = new Normalizer({ pricing: PRICES });
    ok.add(assistantRec({ id: "m1", uuid: "u1", session: "s1" }), FILE("s1"));
    const out = ok.finish();
    expect(checkInvariants(out).ok).toBe(true);

    // Hand-corrupt exactly the way a bad resolver would: a child pointing at a
    // parent that is not in the corpus, with no `parentMissing` to explain it.
    const broken = {
      ...out,
      sessions: [{ ...out.sessions[0], parentSessionId: "ghost", depth: 1, lineageId: "ghost" }],
      forkEdges: [],
    };
    const res = checkInvariants(broken);
    expect(res.ok).toBe(false);
    expect(res.problems.join(" ")).toContain("ghost");
  });
});

describe("project labels", () => {
  it("collapses worktrees onto the repository they belong to", () => {
    // The bug this pins: worktree-isolated subagents run in
    // <repo>/.claude/worktrees/agent-<id>, which made every subagent its own
    // project — 108 labels for 18 repos.
    expect(projectLabel("x", "/Users/n/src/pdum_rfb/.claude/worktrees/agent-ada279")).toBe(
      "pdum_rfb",
    );
    expect(projectLabel("x", "/Users/n/src/pdum_aiui/.claude/worktrees/cc-usage")).toBe(
      "pdum_aiui",
    );
    expect(projectLabel("x", "/Users/n/src/helium")).toBe("helium");
  });

  it("falls back to the slug when a record carries no cwd", () => {
    expect(projectLabel("-Users-n-src-helium")).toBe("helium");
  });
});
