/**
 * Everything we know about Claude Code's transcript schema, encoded as accessor
 * functions rather than as a validating type system.
 *
 * The design bet (docs/proposals/claude-code-usage-analytics.md §5.1): Claude
 * Code ships a new build every few days and adds fields freely — 28 builds in
 * the five weeks of the baseline corpus. A validating parser turns every such
 * addition into a crash or a silent record drop. What we need instead is a
 * **lenient reader plus a loud census**: read defensively here, and let
 * `exploration/cc-usage/{census,diff}.mjs` be the thing that notices drift.
 *
 * Every accessor below obeys three rules:
 *   1. Never throw on a malformed record — return a null-ish value.
 *   2. Never assume a field exists; presence is data.
 *   3. Encode *semantics* the raw JSON does not: which fields are categorical,
 *      which are billing ground truth, which are traps.
 *
 * `Record` here is deliberately `unknown`-ish. Typing the wire format would be
 * the very mistake this module exists to avoid.
 */

/** One parsed JSONL line. Intentionally untyped — see the module docstring. */
export type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// safe navigation
// ---------------------------------------------------------------------------

/** `get(rec, "message.usage.input_tokens")` — never throws. */
export function get(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const k of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const obj = (v: unknown): Record<string, unknown> | undefined =>
  v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

// ---------------------------------------------------------------------------
// record identity & kind
// ---------------------------------------------------------------------------

export const recordType = (rec: Rec): string => str(rec?.type) ?? "<missing>";
export const isAssistant = (rec: Rec): boolean => rec?.type === "assistant";
export const isUser = (rec: Rec): boolean => rec?.type === "user";
/** True for records produced inside a Task subagent / Workflow agent. */
export const isSidechain = (rec: Rec): boolean => rec?.isSidechain === true;

/**
 * The billing dedup key. **The single most important function here.**
 *
 * Claude Code writes ONE RECORD PER CONTENT BLOCK of an assistant turn — a
 * response with thinking + text + tool_use becomes three records, each carrying
 * a byte-identical `message.usage`. Summing over records overstates output
 * tokens by 237% on the baseline corpus (worse than the 2.38x record ratio,
 * because duplication correlates with response size). Group by this key and
 * take ONE member.
 *
 * NUL joins the two ids: it cannot occur inside either, so the composite is
 * unambiguous. Written as an escape, never as a literal — a raw NUL in source
 * makes git treat the file as binary.
 */
export function billingKey(rec: Rec): string | undefined {
  const id = str(get(rec, "message.id"));
  if (!id) return undefined;
  return `${id}\u0000${str(rec?.requestId) ?? ""}`;
}

export const messageId = (rec: Rec): string | undefined => str(get(rec, "message.id"));

/**
 * When two records share a `message.id` but differ in `requestId`, keep the
 * non-sidechain one — the sidechain copy is a replay of the parent's turn and
 * its tokens were never separately billed. (ccusage issue #913.)
 */
export const preferOriginal = (a: Rec, b: Rec): Rec => (isSidechain(a) && !isSidechain(b) ? b : a);

/** Total billable output tokens on one record, across its iteration ledger. */
export const totalOutput = (rec: Rec): number =>
  billableUnits(rec).reduce((n, u) => n + u.output, 0);

/**
 * Choose the canonical record for a billing group. **Read this before changing
 * the dedup.**
 *
 * The per-block records of one response do NOT all carry the same usage. In
 * SUBAGENT transcripts the earlier records hold a placeholder `output_tokens`
 * and only the final one carries the true count — a real group looks like:
 *
 *     out=5      cache_read=156614   [thinking]
 *     out=5      cache_read=156614   [text]
 *     out=5      cache_read=156614   [tool_use]
 *     out=48469  cache_read=156614   [tool_use]   <- the real number
 *
 * `cache_read` / `cache_creation` / `input` are constant across the group, so
 * any member prices those correctly; `output_tokens` is not. Taking the first
 * member undercounted output by 32% corpus-wide (2,062 of 2,759 subagent groups
 * on the worst day disagreed internally) and was invisible for a while because
 * the original "do members agree?" check was run against a MAIN-session file,
 * where they do agree.
 *
 * So: take the member with the most output — **max, not last**. Last-by-timestamp
 * looks equivalent and is not: a fork copy can carry `output_tokens: 0` with a
 * timestamp identical to the original's, so "last" can select the zeroed copy.
 * 44 groups in the baseline corpus differ between the two rules, and max is
 * right in every one. Max is also order-independent, which matters because dedup
 * is global across files and file walk order must not change a number.
 *
 * Ties fall through to `preferOriginal`, which is what settles fork copies whose
 * usage genuinely does match.
 */
export function preferForBilling(a: Rec, b: Rec): Rec {
  const oa = totalOutput(a);
  const ob = totalOutput(b);
  if (oa !== ob) return oa > ob ? a : b;
  return preferOriginal(a, b);
}

// ---------------------------------------------------------------------------
// fork provenance
// ---------------------------------------------------------------------------

/**
 * True when this record declares a session other than the file it lives in.
 *
 * Forking COPIES the inherited prefix into the new session's file, preserving
 * `uuid` / `timestamp` / `requestId` / `message.id`. On the copy, `sessionId`
 * is rewritten to the CONTAINING session while `session_id` keeps the
 * ORIGINATING one — so the snake/camel pair is provenance, not a rename.
 *
 * **But this is a link, not proof of a copy.** Claude Code 2.1.220 also writes
 * `session_id` on records it produced itself, in a file continuing an earlier
 * session — every record marked, not one uuid shared with the named session.
 * Believing this predicate there hands a whole session's spend to its
 * predecessor. `lineage.ts` therefore verifies the claim against the named
 * session's own file before attributing anything, and this function is only a
 * cheap "does the record name someone else" test.
 *
 * Also: only ~78% of records carry `session_id` at all. Builds before 2.1.199
 * omit it entirely, and even after, whole record types (`mode`, `last-prompt`,
 * `custom-title`, most `system`) never carry it — so a fork's boundary record is
 * often unmarked, and the last MARKED record can name a grandparent rather than
 * the parent. Content, not the marker, is what settles both questions.
 */
export function isInherited(rec: Rec): boolean {
  const origin = str(rec?.session_id);
  const container = str(rec?.sessionId);
  return Boolean(origin && container && origin !== container);
}

/**
 * The session named by a record, marker first.
 *
 * Kept for the census and for callers that want the raw claim; the normalizer
 * deliberately does NOT use it for attribution, because of the continuation case
 * described on `isInherited`.
 */
export const originSession = (rec: Rec): string | undefined =>
  str(rec?.session_id) ?? str(rec?.sessionId);

/** The session whose file this record lives in. */
export const containingSession = (rec: Rec): string | undefined => str(rec?.sessionId);

export interface ForkContextRef {
  agentId?: string;
  parentSessionId?: string;
  parentLastUuid?: string;
  contextLength: number;
}

/**
 * A subagent that inherits its parent's context declares it in a
 * `fork-context-ref` record. Note these are themselves copied when the parent
 * session is forked, so one agentId can appear under two session dirs.
 */
export function forkContextRef(rec: Rec): ForkContextRef | undefined {
  if (rec?.type !== "fork-context-ref") return undefined;
  return {
    agentId: str(rec.agentId),
    parentSessionId: str(rec.parentSessionId),
    parentLastUuid: str(rec.parentLastUuid),
    contextLength: num(rec.contextLength),
  };
}

/**
 * Which agent produced this record. `attributionAgent` names the agent TYPE
 * (`Explore`, `Plan`, `general-purpose`, `fork`, a custom name, …) and is on
 * ~76% of sidechain records; `agentId` is the per-instance id.
 */
export const agentIdentity = (rec: Rec): { agentId?: string; agentType?: string } | undefined =>
  isSidechain(rec)
    ? { agentId: str(rec.agentId), agentType: str(rec.attributionAgent) }
    : undefined;

// ---------------------------------------------------------------------------
// names — what a human calls a session or an agent
// ---------------------------------------------------------------------------

/**
 * The three record types that name a session.
 *
 * They are unlike every other record here: `{type, <the name>, sessionId}` and
 * nothing else — **no timestamp and no uuid**. So they cannot be ordered by
 * time, only by position in the file, and they cannot be deduped by uuid. What
 * makes them tractable anyway is that their `sessionId` is always the session
 * of the file they sit in (verified: 12,496 of 12,496 records, zero
 * exceptions), and they appear only in main session files — never in a
 * subagent's or a workflow agent's.
 *
 * They are also re-emitted constantly rather than written once on change: one
 * file carries 444 of them for 3 distinct values. So the useful reduction is
 * "first and last DISTINCT value", not a count.
 */
export const NAME_RECORD_TYPES = ["ai-title", "custom-title", "agent-name"] as const;

/**
 * The name a record assigns to its session, if it assigns one.
 *
 * `custom-title` and `agent-name` are folded together into one `explicit` kind:
 * they are written as a pair and never disagreed in this corpus (0 of 33
 * sessions carrying both), but `agent-name` appears on 4 sessions that have no
 * `custom-title`, so taking either alone would lose those.
 */
export function sessionNameOf(rec: Rec): { kind: "explicit" | "ai"; value: string } | undefined {
  const type = str(rec?.type);
  if (type === "ai-title") {
    const v = str(rec.aiTitle);
    return v ? { kind: "ai", value: v } : undefined;
  }
  if (type === "custom-title" || type === "agent-name") {
    const v = str(type === "custom-title" ? rec.customTitle : rec.agentName);
    return v ? { kind: "explicit", value: v } : undefined;
  }
  return undefined;
}

/** `a<name>-<16 hex>` — an agent whose id encodes a label. */
const NAMED_AGENT = /^a(.+)-[0-9a-f]{16}$/;

/**
 * An agent's name, read straight out of its id.
 *
 * The id is `a<name>-<16 hex>` when there was a name and `a<hex>` when there
 * was not, so no join to the launching `Task` call is needed — which matters,
 * because that call lives in the parent session's records and may have been
 * compacted away. Verified against every agent id in the corpus: 368 of 368
 * classified, no residue.
 *
 * Two different things produce a name, and `agentType` is what separates them:
 *
 *  - `kind: "named"` — an explicit `name` argument to `Task`. These carry NO
 *    `attributionAgent`, so the name is the only label they have.
 *  - `kind: "fork"` — a fork, labelled from the opening words of the prompt
 *    (`where-is-the`, `can-you-change`). Reads like a name but is not one, and
 *    a UI should not present it as though the user chose it.
 */
export function agentNameOf(
  agentId: string | undefined,
  agentType?: string,
): { name?: string; kind: "named" | "fork" | "anonymous" } {
  const m = agentId ? NAMED_AGENT.exec(agentId) : null;
  if (!m) return { kind: "anonymous" };
  return { name: m[1], kind: agentType === "fork" ? "fork" : "named" };
}

/**
 * Which of a session's names to show, and what it came from.
 *
 * Coverage is the reason this is a ladder rather than one field: explicit names
 * reach 34% of sessions, `aiTitle` 75%, `slug` 23%, and only the session id is
 * always there. Falling back is what keeps every row labelled.
 */
export function resolveSessionName(
  n: { explicit?: string; ai?: string; slug?: string },
  sessionId: string,
): { name: string; kind: "explicit" | "ai" | "slug" | "id" } {
  if (n.explicit) return { name: n.explicit, kind: "explicit" };
  if (n.ai) return { name: n.ai, kind: "ai" };
  if (n.slug) return { name: n.slug, kind: "slug" };
  return { name: sessionId.slice(0, 8), kind: "id" };
}

// ---------------------------------------------------------------------------
// usage / tokens — the billing surface
// ---------------------------------------------------------------------------

export interface TokenCounts {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  /** The two cache-write TTL tiers. 1h is priced ~1.6x the 5m rate. */
  cache5m: number;
  cache1h: number;
  webSearches: number;
  webFetches: number;
  serviceTier?: string;
  speed?: string;
}

export function readUsage(usage: unknown): TokenCounts {
  const u = obj(usage);
  return {
    input: num(u?.input_tokens),
    output: num(u?.output_tokens),
    cacheCreate: num(u?.cache_creation_input_tokens),
    cacheRead: num(u?.cache_read_input_tokens),
    cache5m: num(get(u, "cache_creation.ephemeral_5m_input_tokens")),
    cache1h: num(get(u, "cache_creation.ephemeral_1h_input_tokens")),
    webSearches: num(get(u, "server_tool_use.web_search_requests")),
    webFetches: num(get(u, "server_tool_use.web_fetch_requests")),
    serviceTier: str(u?.service_tier),
    speed: str(u?.speed),
  };
}

export interface BillableUnit extends TokenCounts {
  model?: string;
  /** `"message"` | `"fallback_message"` | undefined on pre-iterations builds. */
  iterationType?: string;
}

/**
 * Billing ground truth for one assistant record, as a list of (model, usage)
 * pairs — plural because of model fallback.
 *
 * `message.usage.iterations[]` is the real per-attempt ledger. On a fallback
 * (`type: "fallback_message"`) it holds BOTH the aborted cheap-model attempt
 * and the expensive retry, each with its own `model`, while top-level
 * `message.usage` reflects only the LAST attempt. Pricing the top level alone
 * silently drops the wasted first attempt.
 *
 * When `iterations` is absent (older builds) fall back to top-level usage.
 */
export function billableUnits(rec: Rec): BillableUnit[] {
  const usage = get(rec, "message.usage");
  if (!usage) return [];
  const topModel = str(get(rec, "message.model"));
  const iterations = arr((usage as Record<string, unknown>).iterations);
  if (iterations.length === 0) {
    return [{ model: topModel, iterationType: undefined, ...readUsage(usage) }];
  }
  return iterations.map((it) => {
    const o = obj(it);
    return {
      // per-iteration `model` only appears when it differs from the top-level one
      model: str(o?.model) ?? topModel,
      iterationType: str(o?.type),
      ...readUsage(it),
    };
  });
}

/** A fallback happened: a cheaper model's attempt was thrown away and retried. */
export const hadFallback = (rec: Rec): boolean =>
  arr(get(rec, "message.usage.iterations")).some((it) => obj(it)?.type === "fallback_message");

/**
 * Models that must never be priced. `<synthetic>` is Claude Code's own
 * placeholder for locally-generated assistant messages (e.g. an interrupt
 * notice) — it never hit the API.
 */
export const UNPRICED_MODELS: ReadonlySet<string> = new Set(["<synthetic>"]);

/**
 * Model ids may carry a bracketed context-window variant, e.g.
 * `claude-opus-4-8[1m]` (1M context), priced differently from the base model.
 */
export function splitModel(model: string | undefined): {
  base?: string;
  variant?: string;
} {
  const m = /^(.*?)\[([^\]]+)\]$/.exec(model ?? "");
  return m ? { base: m[1], variant: m[2] } : { base: model, variant: undefined };
}

// ---------------------------------------------------------------------------
// events — the "what went wrong / what got expensive" signals
// ---------------------------------------------------------------------------

export interface Compaction {
  trigger?: string;
  preTokens: number;
  postTokens: number;
  droppedCumulative: number;
  durationMs: number;
  preservedCount: number;
  toolsDiscovered: number;
}

/** Context compaction: the single biggest driver of cache-read cost. */
export function compaction(rec: Rec): Compaction | undefined {
  const cm = obj(rec?.compactMetadata);
  if (!cm) return undefined;
  return {
    trigger: str(cm.trigger),
    preTokens: num(cm.preTokens),
    postTokens: num(cm.postTokens),
    droppedCumulative: num(cm.cumulativeDroppedTokens),
    durationMs: num(cm.durationMs),
    preservedCount: arr(get(cm, "preservedMessages.uuids")).length,
    toolsDiscovered: arr(cm.preCompactDiscoveredTools).length,
  };
}

/** Model fallback events are logged as `type:"system"` with these two fields. */
export function fallbackEvent(rec: Rec): { from?: string; to?: string } | undefined {
  const from = str(rec?.originalModel);
  const to = str(rec?.fallbackModel);
  return from || to ? { from, to } : undefined;
}

/** Work that was paid for and thrown away. */
export const isWasted = (rec: Rec): boolean =>
  rec?.isAbortedMidStream === true || rec?.isApiErrorMessage === true;

export interface ToolUse {
  id?: string;
  name?: string;
  input: unknown;
}

export const toolUses = (rec: Rec): ToolUse[] =>
  arr(get(rec, "message.content"))
    .filter((b) => obj(b)?.type === "tool_use")
    .map((b) => {
      const o = obj(b) ?? {};
      return { id: str(o.id), name: str(o.name), input: o.input };
    });

/**
 * The one line that says what a tool call *did*.
 *
 * A replay that prints tool inputs as JSON is unreadable — `Bash` alone is
 * 17,770 of this corpus's 39,138 calls, and its input is `{command,
 * description, timeout, run_in_background, dangerouslySkipSandbox}` of which
 * only `command` is the story. The key list per tool below was read off the
 * corpus rather than guessed.
 *
 * Unknown tools (MCP servers especially, whose inputs are arbitrary) fall back
 * to the first string-valued field, which is right far more often than a JSON
 * dump and never worse.
 */
const TOOL_SUMMARY_KEYS: Record<string, readonly string[]> = {
  Bash: ["command"],
  Edit: ["file_path"],
  Read: ["file_path"],
  Write: ["file_path"],
  Glob: ["pattern"],
  Grep: ["pattern"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  ToolSearch: ["query"],
  // The launch of a subagent: its name if it was given one, else what it was for.
  Task: ["name", "description"],
  Agent: ["name", "description"],
  TaskCreate: ["subject", "description"],
  TaskUpdate: ["status", "taskId"],
  SendMessage: ["to", "summary"],
};

export function toolSummary(name: string | undefined, input: unknown): string | undefined {
  const o = obj(input);
  if (!o) return undefined;
  for (const k of TOOL_SUMMARY_KEYS[name ?? ""] ?? []) {
    const v = str(o[k]);
    if (v) return v;
  }
  if (TOOL_SUMMARY_KEYS[name ?? ""]) return undefined;
  // Unknown tool: the first string field, longest-first so a `prompt` beats an
  // `id`. Deterministic — key order is not, after a VARIANT round trip.
  const strings = Object.keys(o)
    .sort()
    .map((k) => str(o[k]))
    .filter((v): v is string => !!v);
  return strings.sort((a, b) => b.length - a.length)[0];
}

export interface ToolOutcome {
  shape: "string" | "array" | "object";
  ok?: boolean;
  interrupted?: boolean;
  error?: string;
  exitCode?: number;
  durationMs?: number;
  size: number;
}

/**
 * Tool outcome, read from the `toolUseResult` sidecar on the *user* record that
 * carries the tool_result. Polymorphic (`object | array | string`), so this is
 * pure defensive reading.
 */
export function toolOutcome(rec: Rec): ToolOutcome | undefined {
  const r = rec?.toolUseResult;
  if (r == null) return undefined;
  if (typeof r === "string") return { shape: "string", size: r.length };
  if (Array.isArray(r)) return { shape: "array", size: r.length };
  const o = obj(r);
  if (!o) return undefined;
  const stderr = str(o.stderr);
  return {
    shape: "object",
    ok: typeof o.success === "boolean" ? o.success : undefined,
    interrupted: o.interrupted === true,
    error: str(o.error) || (stderr ? stderr : undefined),
    exitCode: typeof o.exitCode === "number" ? o.exitCode : undefined,
    durationMs: typeof o.durationMs === "number" ? o.durationMs : undefined,
    size: 0,
  };
}

/** Content-block types on one record (records are per-block, so usually one). */
export const blockTypes = (rec: Rec): (string | undefined)[] =>
  arr(get(rec, "message.content")).map((b) => str(obj(b)?.type));

/** Thinking is billed as output tokens; tracking it separately explains spend. */
export const thinkingChars = (rec: Rec): number =>
  arr(get(rec, "message.content"))
    .filter((b) => obj(b)?.type === "thinking")
    .reduce<number>((n, b) => n + (str(obj(b)?.thinking)?.length ?? 0), 0);

// ---------------------------------------------------------------------------
// categorical dimensions — the cross-filter axes for the Mosaic layer
// ---------------------------------------------------------------------------

export interface Dimension {
  name: string;
  path: string;
  grain: "assistant" | "user" | "system" | "any";
  /** Fraction of records carrying it in the July 2026 corpus. */
  presence?: number;
  values?: readonly string[];
  note?: string;
}

/**
 * Every low-cardinality field worth exposing as a filterable dimension.
 * `presence` is a reminder that most are optional — a chart must handle the
 * null bucket.
 */
export const DIMENSIONS: readonly Dimension[] = [
  // --- turn grain ---
  { name: "model", path: "message.model", grain: "assistant", presence: 1.0 },
  { name: "stopReason", path: "message.stop_reason", grain: "assistant" },
  { name: "serviceTier", path: "message.usage.service_tier", grain: "assistant" },
  { name: "speed", path: "message.usage.speed", grain: "assistant" },
  {
    name: "effort",
    path: "effort",
    grain: "assistant",
    presence: 0.3,
    values: ["medium", "high", "xhigh"],
  },
  { name: "entrypoint", path: "entrypoint", grain: "any", values: ["cli", "sdk-cli"] },
  {
    name: "sessionKind",
    path: "sessionKind",
    grain: "any",
    presence: 0.01,
    note: '"bg" = background session',
  },
  { name: "userType", path: "userType", grain: "any" },
  {
    name: "isSidechain",
    path: "isSidechain",
    grain: "any",
    note: "true inside a subagent",
  },

  // --- attribution: what *caused* this spend. The efficiency axis. ---
  { name: "attributionSkill", path: "attributionSkill", grain: "assistant", presence: 0.038 },
  { name: "attributionPlugin", path: "attributionPlugin", grain: "assistant", presence: 0.028 },
  {
    name: "attributionMcpServer",
    path: "attributionMcpServer",
    grain: "assistant",
    presence: 0.059,
  },
  { name: "attributionMcpTool", path: "attributionMcpTool", grain: "assistant", presence: 0.059 },
  { name: "attributionAgent", path: "attributionAgent", grain: "assistant", presence: 0.758 },

  // --- project / place ---
  { name: "cwd", path: "cwd", grain: "any", note: "high cardinality but the real project key" },
  { name: "gitBranch", path: "gitBranch", grain: "any" },
  { name: "version", path: "version", grain: "any", note: "Claude Code build — the drift axis" },

  // --- user grain ---
  { name: "permissionMode", path: "permissionMode", grain: "user", presence: 0.047 },
  { name: "promptSource", path: "promptSource", grain: "user", presence: 0.047 },
  { name: "originKind", path: "origin.kind", grain: "user", presence: 0.047 },
  { name: "toolDenialKind", path: "toolDenialKind", grain: "user", presence: 0.0004 },

  // --- system grain ---
  { name: "level", path: "level", grain: "system", values: ["info", "notice", "warning"] },
  {
    name: "compactTrigger",
    path: "compactMetadata.trigger",
    grain: "system",
    values: ["auto", "manual"],
  },
  { name: "apiRefusalCategory", path: "apiRefusalCategory", grain: "system", presence: 0.003 },
] as const;

// ---------------------------------------------------------------------------
// known traps — encoded so the next reader does not rediscover them
// ---------------------------------------------------------------------------

export interface Trap {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  what: string;
  detect?: string;
  fix: string;
}

export const TRAPS: readonly Trap[] = [
  {
    id: "per-block-record-duplication",
    severity: "critical",
    what: "One API response is written as one record per content block, each repeating the full message.usage.",
    detect: "count(assistant records) / count(distinct message.id) — 2.38 on the July 2026 corpus",
    fix: "Group by billingKey(); take one member per group.",
  },
  {
    id: "subagent-files-missed",
    severity: "critical",
    what: "Subagent + workflow transcripts live in <sessionId>/subagents/**, not <sessionId>.jsonl.",
    detect: "Compare a recursive walk to a `<slug>/*.jsonl` glob — 477 files vs 109.",
    fix: "Walk the project dir recursively; tag each file with its kind.",
  },
  {
    id: "partial-usage-in-a-billing-group",
    severity: "critical",
    what:
      "The per-block records of one response do NOT all carry the same usage. In subagent " +
      "transcripts the earlier records hold a placeholder output_tokens (often 5) and only the " +
      "final record carries the true count; cache_read/cache_creation/input ARE constant. " +
      "Taking the first member of a billing group undercounts output by ~32% corpus-wide.",
    detect:
      "group subagent assistant records by (message.id, requestId) and count groups whose " +
      "members disagree on output_tokens — 2,062 of 2,759 on the worst day",
    fix: "preferForBilling(): take the member with the most output, not the first.",
  },
  {
    id: "fork-copies-the-prefix",
    severity: "critical",
    what:
      "Resuming or forking COPIES the inherited transcript prefix into the new session's file, " +
      "preserving uuid / timestamp / requestId / message.id. The same billed turn exists in 2+ " +
      "files (5.5% of message.ids, chains up to 4 deep). Per-file summing double-counts.",
    detect: "count message.ids appearing in more than one file",
    fix: "Dedup by billingKey() across the WHOLE corpus, then attribute via lineage.ts.",
  },
  {
    id: "session-id-marks-a-link-not-a-copy",
    severity: "critical",
    what:
      "session_id names a session the record is LINKED to, which is not the same as one it was " +
      "COPIED from. Claude Code 2.1.220 continues a session into a fresh file with session_id on " +
      "every record and not one shared uuid (observed: b9282e52 -> 1cfc5437, 6 minutes apart, " +
      "0 records in common, the child's first turn starting a fresh cache). Attributing by the " +
      "marker alone gives that whole session's spend to its predecessor.",
    detect:
      "session files where every record's session_id names another session yet the leading-uuid " +
      "run against that session's file is 0",
    fix: "Believe session_id only when the named session's file actually contains that uuid.",
  },
  {
    id: "the-marker-names-an-ancestor-not-the-parent",
    severity: "high",
    what:
      "The LAST marked record in a fork's file names the session that produced it — which after a " +
      "fork of a fork is the GRANDparent, because the intervening records the middle session added " +
      "are `system`/`user` types that carry no session_id. Believing it turns a chain into a star: " +
      "63baa90e -> 4df4dbb9 -> {70486150, de93c3a5} reads as three siblings of 63baa90e.",
    detect:
      "compare the leading-uuid run against the marked session with the run against every other " +
      "file — a longer run names a nearer ancestor",
    fix: "Pick the parent by longest leading-uuid run; use the marker to confirm, not to decide.",
  },
  {
    id: "session-id-is-provenance-not-a-rename",
    severity: "high",
    what:
      "sessionId and session_id are NOT a naming migration. On a copied record sessionId is " +
      "rewritten to the CONTAINING session while session_id keeps the ORIGINATING one. " +
      "Introduced in Claude Code 2.1.199; absent before, hence ~78% presence.",
    detect: "records where session_id !== sessionId are inherited, not native",
    fix: "isInherited() / originSession(); never treat session_id as an alias.",
  },
  {
    id: "fallback-iteration-dropped",
    severity: "high",
    what:
      "On model fallback, top-level message.usage reflects only the final attempt; the discarded " +
      "cheaper attempt is billed but visible only in message.usage.iterations[].",
    detect: 'assistant records where iterations[].type includes "fallback_message"',
    fix: "Price over billableUnits(), never over top-level usage alone.",
  },
  {
    id: "no-cost-field",
    severity: "high",
    what: "There is NO costUSD/total_cost_usd anywhere in the transcript. Cost is always derived.",
    detect: "grep costUSD ~/.claude/projects — zero hits.",
    fix: "Carry a versioned pricing table; stamp every number with the table version.",
  },
  {
    id: "no-image-token-counter",
    severity: "medium",
    what:
      "Anthropic bills images as ordinary input tokens; message.usage has no image counter and " +
      "no price table has an Anthropic image rate. Exact image attribution is impossible.",
    fix: "Estimate from PNG IHDR / JPEG SOFn dimensions via w*h/750; label it an estimate.",
  },
  {
    id: "synthetic-model",
    severity: "medium",
    what: 'model can be "<synthetic>" for locally generated messages that never hit the API.',
    fix: "Skip UNPRICED_MODELS before pricing.",
  },
  {
    id: "model-variant-suffix",
    severity: "medium",
    what: "Model ids can carry a bracketed variant, e.g. claude-opus-4-8[1m] (1M context), priced differently.",
    fix: "splitModel() before pricing lookup; price the variant, do not silently strip it.",
  },
] as const;
