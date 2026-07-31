/**
 * grains.ts — the row shapes cc-assay writes. These ARE the contract:
 * everything downstream queries them, and the app mirrors them.
 *
 * Split out of normalize.ts, which was 1626 lines, so that `parquet.ts` and
 * `export.ts` can take nine type names without importing a 1000-line class
 * module to get them. Type declarations only — no behaviour lives here.
 */
import type { ForkKind, ParentSource } from "./lineage.ts";

// ---------------------------------------------------------------------------
// row shapes — these ARE the contract; everything downstream queries them
// ---------------------------------------------------------------------------

export interface TurnRow {
  /** Which machine produced this turn. Empty for a single-machine run. */
  hostId: string;
  messageId: string;
  requestId?: string;
  /** Record uuid of the chosen copy. Joins a turn to lineage and to events. */
  uuid?: string;
  /** The session that produced (and paid for) this turn. */
  sessionId: string;
  /** The fork family `sessionId` belongs to — denormalised for cross-filtering. */
  lineageId: string;
  /** The file this copy was read from — may differ after a fork. */
  fileSessionId: string;
  projectSlug: string;
  project: string;
  cwd?: string;
  gitBranch?: string;
  ts: number;
  model?: string;
  modelVariant?: string;
  effort?: string;
  stopReason?: string;
  serviceTier?: string;
  speed?: string;
  /** `main` | `subagent` | `workflow-agent` — where the turn executed. */
  context: string;
  agentId?: string;
  agentType?: string;
  /** `wf_…` for a workflow-spawned agent; absent everywhere else. */
  workflowId?: string;
  entrypoint?: string;
  sessionKind?: string;
  ccVersion?: string;
  attributionSkill?: string;
  attributionPlugin?: string;
  attributionMcpServer?: string;
  attributionMcpTool?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheReadTokens: number;
  webSearches: number;
  webFetches: number;
  hadFallback: boolean;
  /** Output tokens billed for an attempt that was thrown away. */
  wastedOutputTokens: number;
  nBlocks: number;
  nThinkingChars: number;
  nToolUses: number;
  nImages: number;
  estImageTokens: number;
  aborted: boolean;
  costInput: number;
  costOutput: number;
  costCacheCreate: number;
  costCacheRead: number;
  costTotal: number;
  pricingVersion: string;
  /** True when no price entry matched — cost columns are zero, not free. */
  unpriced: boolean;
}

export interface ToolCallRow {
  messageId: string;
  toolUseId?: string;
  sessionId: string;
  ts: number;
  toolName: string;
  isMcp: boolean;
  mcpServer?: string;
  context: string;
  ok?: boolean;
  interrupted?: boolean;
  errorKind?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface EventRow {
  ts: number;
  sessionId: string;
  projectSlug: string;
  kind: string;
  /** Deliberately untyped JSON — this is where new CC features land first. */
  payload: string;
}

export interface SessionRow {
  /** Which machine the session ran on — sessions do not span machines. */
  hostId: string;
  sessionId: string;
  projectSlug: string;
  project: string;
  cwd?: string;
  slug?: string;
  // --- names (proposal §9) ---
  /**
   * What to call this session: the newest explicit name, else the newest
   * AI-generated title, else the slug, else the id's first 8 characters.
   * Always populated — the fallbacks exist so no row is unlabelled.
   */
  name: string;
  /** Which rung of that ladder `name` came from. */
  nameKind: "explicit" | "ai" | "slug" | "id";
  /**
   * The same ladder applied to each source's FIRST value instead of its last.
   *
   * A session can be renamed, and re-ingesting weeks later would then relabel
   * rows that an earlier analysis referred to by name. This field is the one
   * that does not move: it is what a note written last month still matches.
   * (The stable *key* is `sessionId`; these are both labels.)
   */
  nameFirst: string;
  /** True when any name source changed within the session — `name != nameFirst`. */
  nameChanged: boolean;
  /** Newest `/rename` (or agent name); absent if never named explicitly. */
  customTitle?: string;
  /** First explicit name, when it later changed. */
  customTitleFirst?: string;
  /** Newest system-generated descriptive title. */
  aiTitle?: string;
  /** First AI title, when it later changed. */
  aiTitleFirst?: string;
  // --- lineage: a file is not a session (proposal §1.6) ---
  /** The session this one was forked/resumed from. Absent on a root. */
  parentSessionId?: string;
  /** Root of the fork family; equals `sessionId` on a root. Groups a lineage. */
  lineageId: string;
  /** Hops to the root. 0 on a root. */
  depth: number;
  /**
   * Where this session branched off, **in the parent's timeline**. Absent on a
   * root. This is the origin of a fork edge, and it can be far in the past: the
   * fork of a session that went cold a week ago has a `forkPointTs` a week
   * before `createdTs`.
   */
  forkPointTs?: number;
  /** `marker` (2.1.199+ `session_id`) or `uuid-overlap` (content). */
  parentSource?: ParentSource;
  /** `copy` (the prefix is in this file) or `continuation` (only the link is). */
  parentKind?: ForkKind;
  /** The parent edge rested on file creation order, not content. Draw it dashed. */
  parentAmbiguous: boolean;
  /** Records carried in from ancestors — context this session did not produce. */
  nRecordsInherited: number;
  /** Billed turns this file carries a copy of but did not pay for. */
  nTurnsInherited: number;
  /** What those inherited turns cost their real owner. Never sums with siblings. */
  inheritedCost: number;
  // --- time ---
  /** File birthtime: for a fork, the wall-clock moment it came into existence. */
  createdTs?: number;
  /** First record this session produced itself, turn or not. */
  firstNativeTs?: number;
  /** Last record in its file. */
  lastNativeTs?: number;
  /**
   * First/last *billed turn* — **absent when the session produced none**, which
   * five sessions in the baseline corpus did. Nullable rather than zero on
   * purpose: an epoch-zero timestamp puts a mark at 1970 in any chart that
   * forgets to check, whereas a null just disappears. Use
   * `coalesce(firstTs, firstNativeTs)` when the question is "when was this
   * session alive" rather than "when did it spend".
   */
  firstTs?: number;
  lastTs?: number;
  spanSeconds: number;
  activeSeconds: number;
  /** Absent with no turns: a session that did nothing has no duty cycle. */
  dutyCycle?: number;
  // --- volume ---
  nTurnsNative: number;
  nSubagentTurns: number;
  nAgentRuns: number;
  nCompactions: number;
  peakContextTokens: number;
  /** Only this sums. Inherited turns belong to an ancestor. */
  nativeCost: number;
  models: string;
  ccVersions: string;
}

/**
 * One parent→child fork edge. Denormalised on purpose: a timeline draws one
 * bezier per row and should not have to self-join `sessions` to find the two
 * endpoints in time.
 */
export interface ForkEdgeRow {
  childSessionId: string;
  parentSessionId: string;
  lineageId: string;
  depth: number;
  projectSlug: string;
  project: string;
  /**
   * `copy` — the prefix is physically in the child's file (§1.6's fork).
   * `continuation` — the link is declared but nothing was copied; the edge
   * leaves the parent's END rather than its middle. See `ForkKind`.
   */
  kind: ForkKind;
  /** In the PARENT's timeline: the last inherited record (or its last record). */
  forkPointTs: number;
  /** In the CHILD's timeline: when its file appeared (0 = unknown). */
  childCreatedTs: number;
  /** In the CHILD's timeline: its first record of its own (0 = it made none). */
  childFirstNativeTs: number;
  /** How long the parent sat cold before being forked. Can be days. */
  lagSeconds: number;
  nRecordsInherited: number;
  nTurnsInherited: number;
  /** What the inherited prefix cost when it was first produced. */
  inheritedCost: number;
  source: ParentSource;
  ambiguous: boolean;
  /** A marker named the parent, but its file is not in the corpus. */
  parentMissing: boolean;
  // --- drawability -------------------------------------------------------
  /**
   * Whether each end of this edge produced a billed turn.
   *
   * A timeline that builds its bars by aggregating `turns` — which is the right
   * way to build one, because then every cross-filter clause resolves — has no
   * bar for a session that produced none, and an edge touching one silently
   * vanishes. In this corpus that is `4df4dbb9`, and it sits in the MIDDLE of a
   * chain, so three of ten edges disappear and `63baa90e → … → de93c3a5` breaks
   * in half. These two booleans make that a decision rather than an accident.
   */
  parentHasTurns: boolean;
  childHasTurns: boolean;
  /**
   * The nearest ancestor that DOES have billed turns, and where this child
   * branched off **in that ancestor's** timeline. Equal to `parentSessionId` /
   * `forkPointTs` whenever the parent has turns, which is 8 of 10 edges here.
   *
   * This invents nothing: it is the same last-inherited-record question asked
   * further up the chain, and it is what lets a turns-derived timeline anchor a
   * grandchild when the intermediate has no bar. Absent when no ancestor has
   * turns at all.
   *
   * Unlike a materialised lane, this stays *true* under a brush — the anchor may
   * itself be filtered out, in which case the edge drops exactly as it would
   * have anyway. It degrades; it does not lie.
   */
  billedAncestorSessionId?: string;
  billedAncestorForkPointTs?: number;
}

/** One fork family — the unit a human means by "a session". */
export interface LineageRow {
  lineageId: string;
  rootSessionId: string;
  projectSlug: string;
  project: string;
  nSessions: number;
  nForks: number;
  maxDepth: number;
  firstTs: number;
  lastTs: number;
  nTurns: number;
  totalCost: number;
  /** Comma-joined, in fork order. Cheap membership tests without a join. */
  sessionIds: string;
}

/**
 * One subagent or workflow-agent instance. A mark on its launching session's
 * lane, and the answer to "what did agents actually cost".
 */
export interface AgentRunRow {
  agentId: string;
  /** `general-purpose`, `Explore`, `fork`, … Absent on pre-`attributionAgent` builds. */
  agentType?: string;
  /**
   * The label carried in the agent id. Read from the id itself rather than
   * joined to the launching `Task` call, which may have been compacted away.
   */
  name?: string;
  /**
   * `named` (an explicit `Task` name — these carry no `agentType`, so the name
   * is their only label), `fork` (a label built from the prompt's opening
   * words, which reads like a name but was not chosen), or `anonymous`.
   */
  nameKind: "named" | "fork" | "anonymous";
  /** The session that launched it. */
  parentSessionId: string;
  lineageId: string;
  projectSlug: string;
  project: string;
  /** `subagent` | `workflow-agent`. */
  context: string;
  workflowId?: string;
  firstTs: number;
  lastTs: number;
  spanSeconds: number;
  nTurns: number;
  nToolUses: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  models: string;
  /** From `fork-context-ref`: how much parent context it started with. */
  inheritedContextLength?: number;
  /** From `fork-context-ref`: the parent record it forked at. */
  parentLastUuid?: string;
}

export interface ImageRow {
  /**
   * The *user record's* uuid, not a `msg_…` id — user records carry no
   * `message.id`. Distinct images are identified by `hash`, not by this: the
   * `tool_result` and `toolUseResult` carriers are two views of one payload, so
   * 362 rows here are 276 distinct images.
   */
  uuid: string;
  sessionId: string;
  ts: number;
  carrier: string;
  mediaType?: string;
  width?: number;
  height?: number;
  bytesBase64: number;
  estTokens: number;
  hash: string;
}

export interface Normalized {
  turns: TurnRow[];
  toolCalls: ToolCallRow[];
  events: EventRow[];
  sessions: SessionRow[];
  forkEdges: ForkEdgeRow[];
  lineages: LineageRow[];
  agentRuns: AgentRunRow[];
  images: ImageRow[];
  stats: NormalizeStats;
}

export interface NormalizeStats {
  files: number;
  bytes: number;
  records: number;
  parseErrors: number;
  assistantRecords: number;
  dedupedTurns: number;
  /** How much a naive per-record sum would have overstated output tokens. */
  naiveOutputTokens: number;
  dedupedOutputTokens: number;
  inheritedTurnsSeen: number;
  crossFileDuplicates: number;
  unpricedTurns: number;
  /** Data-quality observation, not a pipeline fault — see checkInvariants. */
  turnsWithoutTimestamp: number;
  /**
   * Billing groups whose members disagreed on output_tokens. Surfaced because
   * this is the regime where `preferForBilling` is load-bearing: if a refactor
   * ever reverted to "keep the first member", output would silently drop by
   * roughly this population's share. A non-zero value here is normal (subagent
   * transcripts), a zero value on a corpus with subagents is suspicious.
   */
  groupsWithVaryingOutput: number;
  // --- lineage ---
  sessionFiles: number;
  /** Session files carrying no `session_id` on any record — pre-2.1.199 builds. */
  sessionFilesWithoutMarker: number;
  forkEdges: number;
  forkEdgesFromMarker: number;
  /** Edges whose direction rested on file creation order, not on content. */
  forkEdgesAmbiguous: number;
  lineages: number;
  maxForkDepth: number;
  /** Sessions that share a prefix with another file but whose parent is unknown. */
  unresolvedForks: number;
  /**
   * Turns moved off the file that carried them by content-based lineage — the
   * measurable value of the pre-2.1.199 fallback. Marker-attributed turns are
   * not counted here; they never needed it.
   */
  reattributedTurns: number;
  agentRuns: number;
  totalCost: number;
  pricingVersion: string;
}
