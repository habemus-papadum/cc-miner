/**
 * The normalizer: raw JSONL records → the analytic grains.
 *
 * This is where every trap in `fields.ts` is actually paid off. The order of
 * operations is load-bearing:
 *
 *   1. **Collect** every assistant record across the WHOLE corpus, keyed by
 *      `billingKey()`. Not per file, not per session — forking copies billed
 *      turns into sibling files, so anything narrower double-counts.
 *   2. **Choose** one record per key (`preferForBilling`: the member carrying
 *      the real output count; ties go to the non-sidechain copy).
 *   3. **Resolve the fork forest** (`lineage.ts`) — which session file is a copy
 *      of which, and where it branched off.
 *   4. **Attribute** each surviving turn to the session that produced it: the
 *      `session_id` marker where the build wrote one, otherwise the root-most
 *      ancestor whose file already held that record's uuid.
 *   5. **Price** over `billableUnits()` — the iterations ledger — never over
 *      top-level usage, which drops discarded fallback attempts.
 *
 * Step 3 must precede step 4, which is why lineage is resolved in `finish()`
 * rather than while streaming: on a pre-2.1.199 build an inherited record is
 * indistinguishable from a native one until the whole corpus is in memory. The
 * same reason defers *events* to `finish()` — a fork copies the parent's
 * compaction records too, so they need the same dedup-and-attribute treatment
 * turns get.
 *
 * The invariant worth asserting: `SUM(sessions.nativeCost) === corpus total`.
 * `checkInvariants()` does exactly that, and the CLI runs it every time.
 */

import type { Rec } from "./fields.ts";
import type {
  AgentRunRow,
  EventRow,
  ForkEdgeRow,
  ImageRow,
  LineageRow,
  Normalized,
  NormalizeStats,
  SessionRow,
  ToolCallRow,
  TurnRow,
} from "./grains.ts";

// Re-exported so parquet.ts, run.ts, index.ts and the tests are untouched by the
// split: the row shapes moved, the import path did not have to.
export type * from "./grains.ts";
export { checkInvariants, type InvariantResult } from "./invariants.ts";

import {
  agentIdentity,
  agentNameOf,
  arr,
  billableUnits,
  billingKey,
  blockTypes,
  compaction,
  fallbackEvent,
  forkContextRef,
  get,
  hadFallback,
  isInherited,
  isWasted,
  num,
  obj,
  preferForBilling,
  resolveSessionName,
  sessionNameOf,
  splitModel,
  str,
  thinkingChars,
  toolOutcome,
  toolUses,
  totalOutput,
  UNPRICED_MODELS,
} from "./fields.ts";
import { imageRefs } from "./images.ts";
import type { LineageResolution, SessionDigest } from "./lineage.ts";
import { branchPoint, originForRecord, resolveLineage } from "./lineage.ts";
import type { PriceTable } from "./pricing.ts";
import { priceUnit } from "./pricing.ts";
import type { FileKind, TranscriptFile } from "./scan.ts";
import { projectLabel, repoRoot } from "./scan.ts";

/** Gap above which a session is considered idle rather than working. */
export const DEFAULT_IDLE_GAP_SECONDS = 30 * 60;

const tsOf = (rec: Rec): number => {
  const t = str(rec.timestamp);
  if (!t) return 0;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
};

const contextOf = (kind: FileKind): string =>
  kind === "session" ? "main" : kind === "workflow-journal" ? "workflow-journal" : kind;

/**
 * `JSON.stringify` with object keys sorted, at every depth.
 *
 * Two things depend on this, and both were bugs before it existed:
 *
 *  1. Records without a uuid — `relocated` is the one in practice — are deduped
 *     by their serialized payload. A fork copy does not always preserve key
 *     order, so plain `stringify` gave two spellings of one record two dedup
 *     keys and drew the same relocation twice.
 *  2. The grains must not depend on which ingest path produced them. Parquet
 *     VARIANT normalises key order, so a record read back from the raw layer
 *     serializes differently from the same record read from JSONL. Canonical
 *     form is what makes the two byte-identical.
 */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(sort);
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sort(o[k])]),
    );
  };
  return JSON.stringify(sort(value));
}

// ---------------------------------------------------------------------------
// the accumulator
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  pricing: PriceTable;
  idleGapSeconds?: number;
  /** Skip image header decoding — much faster when images are not the question. */
  skipImages?: boolean;
}

/** One API response: the chosen record for usage, the union of all structure. */
interface BilledTurn {
  rec: Rec;
  file: TranscriptFile;
  uuids: Set<string>;
  blocks: number;
  toolUses: ReturnType<typeof toolUses>;
  thinkingChars: number;
}

/** An event held until lineage is known — see the module docstring. */
interface PendingEvent {
  ts: number;
  uuid?: string;
  markedOrigin?: string;
  file: TranscriptFile;
  kind: string;
  payload: string;
}

export class Normalizer {
  private readonly opts: Required<Omit<NormalizeOptions, "pricing">> & { pricing: PriceTable };
  /**
   * billingKey → the winning record (for usage + envelope) PLUS the structure
   * unioned across every record sharing that key.
   *
   * The subtlety that cost a bug: usage is *duplicated* across a response's
   * per-block records, but content is *partitioned* across them. Deduping for
   * billing and deduping for structure are different operations — take one
   * record's usage, but every record's blocks. `uuids` guards the union against
   * fork copies, which repeat the same uuid in a sibling file.
   */
  private readonly billed = new Map<string, BilledTurn>();
  /** messageId → set of files, purely to measure fork duplication. */
  private readonly seenIn = new Map<string, Set<string>>();
  private readonly toolResults = new Map<string, Rec>();
  /**
   * Images ride on USER records, not assistant ones, so they are collected on
   * their own pass rather than off the back of a turn. Keyed by record uuid so
   * a fork copy of the same paste is not counted twice.
   */
  private readonly imagesByUuid = new Map<string, ImageRow[]>();
  /** Buffered until `finish()`; deduped by record uuid, then attributed. */
  private readonly pendingEvents: PendingEvent[] = [];
  /**
   * projectSlug → the shortest repo root seen under it.
   *
   * A turn's own `cwd` is the wrong thing to label a project with: a subagent
   * may run in `<repo>/packages/foo` or in a `.claude/worktrees/agent-<id>`
   * isolation worktree, which split one repository into dozens of "projects"
   * (108 labels for 18 repos before this). The shortest root under a slug is
   * the repository itself, and every turn under that slug inherits it.
   */
  private readonly slugRoot = new Map<string, string>();
  /** sessionId → per-session facts that do not come from turns. */
  private readonly sessionMeta = new Map<
    string,
    {
      hostId: string;
      slug?: string;
      cwd?: string;
      projectSlug: string;
      /**
       * First and last value of each name source, in file order.
       *
       * File order is the ONLY order available — naming records carry no
       * timestamp — and it is what both ingest paths already guarantee within a
       * file. `first` is set once and `last` overwritten, so no sort is needed
       * and the whole thing costs one comparison per naming record.
       */
      explicitFirst?: string;
      explicitLast?: string;
      aiFirst?: string;
      aiLast?: string;
    }
  >();
  /**
   * One digest per session-kind FILE: the ordered uuids that let `lineage.ts`
   * recover the fork forest. Bounded by the top-level transcripts only —
   * subagent files never fork, so they are not indexed.
   */
  private readonly digests = new Map<string, SessionDigest>();
  /** agentId → what its file and `fork-context-ref` say about it. */
  private readonly agentMeta = new Map<
    string,
    { context: string; workflowId?: string; projectSlug: string; dirSessionId: string }
  >();
  private readonly agentForkRefs = new Map<
    string,
    { contextLength: number; parentLastUuid?: string }
  >();
  private lineage?: LineageResolution;
  readonly stats: NormalizeStats;

  constructor(options: NormalizeOptions) {
    this.opts = {
      pricing: options.pricing,
      idleGapSeconds: options.idleGapSeconds ?? DEFAULT_IDLE_GAP_SECONDS,
      skipImages: options.skipImages ?? false,
    };
    this.stats = {
      files: 0,
      bytes: 0,
      records: 0,
      parseErrors: 0,
      assistantRecords: 0,
      dedupedTurns: 0,
      naiveOutputTokens: 0,
      dedupedOutputTokens: 0,
      inheritedTurnsSeen: 0,
      crossFileDuplicates: 0,
      unpricedTurns: 0,
      turnsWithoutTimestamp: 0,
      groupsWithVaryingOutput: 0,
      sessionFiles: 0,
      sessionFilesWithoutMarker: 0,
      forkEdges: 0,
      forkEdgesFromMarker: 0,
      forkEdgesAmbiguous: 0,
      lineages: 0,
      maxForkDepth: 0,
      unresolvedForks: 0,
      reattributedTurns: 0,
      agentRuns: 0,
      totalCost: 0,
      pricingVersion: options.pricing.version,
    };
  }

  noteFile(file: TranscriptFile): void {
    this.stats.files++;
    this.stats.bytes += file.bytes;
    // Register the file even if it holds nothing readable: a session that
    // produced no billed turn is still a session, and a fork that produced
    // none is exactly the row a timeline must draw to show the fork happened.
    if (file.kind === "session") this.digestFor(file);
    if (file.agentId) this.agentMetaFor(file, file.agentId);
  }

  noteParseError(): void {
    this.stats.parseErrors++;
  }

  private digestFor(file: TranscriptFile): SessionDigest {
    let d = this.digests.get(file.fileSessionId);
    if (!d) {
      d = {
        sessionId: file.fileSessionId,
        projectSlug: file.projectSlug,
        createdMs: file.createdMs,
        uuids: [],
        ts: [],
        uuidSet: new Set(),
        markerInherited: 0,
        markerPresent: false,
        records: 0,
      };
      this.digests.set(file.fileSessionId, d);
    }
    return d;
  }

  private agentMetaFor(file: TranscriptFile, agentId: string) {
    let m = this.agentMeta.get(agentId);
    if (!m) {
      m = {
        context: contextOf(file.kind),
        workflowId: file.workflowId,
        projectSlug: file.projectSlug,
        dirSessionId: file.fileSessionId,
      };
      this.agentMeta.set(agentId, m);
    }
    return m;
  }

  /** Feed one record. Order within a file matters; order across files does not. */
  add(rec: Rec, file: TranscriptFile): void {
    this.stats.records++;
    const cwd = str(rec.cwd);
    if (cwd) {
      const root = repoRoot(cwd);
      const known = this.slugRoot.get(file.projectSlug);
      if (known === undefined || root.length < known.length) {
        this.slugRoot.set(file.projectSlug, root);
      }
    }
    if (file.kind === "session") this.digestAdd(rec, file);
    if (file.agentId) this.agentMetaFor(file, file.agentId);

    const type = str(rec.type);

    if (type === "assistant") {
      this.stats.assistantRecords++;
      this.stats.naiveOutputTokens += num(get(rec, "message.usage.output_tokens"));
      if (isInherited(rec)) this.stats.inheritedTurnsSeen++;

      const mid = str(get(rec, "message.id"));
      if (mid) {
        let files = this.seenIn.get(mid);
        if (!files) {
          files = new Set();
          this.seenIn.set(mid, files);
        }
        files.add(file.path);
      }

      const key = billingKey(rec);
      if (key) {
        let entry = this.billed.get(key);
        if (!entry) {
          entry = { rec, file, uuids: new Set(), blocks: 0, toolUses: [], thinkingChars: 0 };
          this.billed.set(key, entry);
        } else {
          // NOT "keep the first". A group's members disagree on output_tokens
          // (see fields.ts preferForBilling) — the final record carries the real
          // count. Ties fall through to the non-sidechain copy, which settles
          // fork duplicates.
          const before = totalOutput(entry.rec);
          entry.rec = preferForBilling(entry.rec, rec);
          if (totalOutput(entry.rec) !== before) this.stats.groupsWithVaryingOutput++;
        }
        const uuid = str(rec.uuid);
        // A fork copies whole records; without this guard its blocks would be
        // unioned in a second time and inflate nToolUses / nBlocks.
        if (!uuid || !entry.uuids.has(uuid)) {
          if (uuid) entry.uuids.add(uuid);
          entry.blocks += blockTypes(rec).length;
          entry.toolUses.push(...toolUses(rec));
          entry.thinkingChars += thinkingChars(rec);
        }
      }
      this.recordSessionMeta(rec, file);
      return;
    }

    if (type === "user") {
      // Tool results live on user records and are joined to their tool_use by id.
      for (const block of arr(get(rec, "message.content"))) {
        const b = obj(block);
        if (b?.type === "tool_result") {
          const id = str(b.tool_use_id);
          if (id) this.toolResults.set(id, rec);
        }
      }
      if (!this.opts.skipImages) this.collectImages(rec, file);
      this.recordSessionMeta(rec, file);
      return;
    }

    if (type === "system") {
      const c = compaction(rec);
      if (c) this.queueEvent(rec, file, "compaction", c);
      const fb = fallbackEvent(rec);
      if (fb) this.queueEvent(rec, file, "fallback", fb);
      const refusal = str(rec.apiRefusalCategory);
      if (refusal) {
        this.queueEvent(rec, file, "refusal", {
          category: refusal,
          uuid: str(rec.refusedUserMessageUuid),
        });
      }
      return;
    }

    const named = sessionNameOf(rec);
    if (named) {
      // These records carry no timestamp, so first/last mean *file order*.
      // Their `sessionId` is always their own file's, so no origin machinery
      // applies — and they only ever appear in main session files.
      const m = this.metaFor(str(rec.sessionId) ?? file.fileSessionId, file);
      if (named.kind === "explicit") {
        m.explicitFirst ??= named.value;
        m.explicitLast = named.value;
      } else {
        m.aiFirst ??= named.value;
        m.aiLast = named.value;
      }
      return;
    }

    if (type === "fork-context-ref") {
      const ref = forkContextRef(rec);
      // The subagent's own declaration of the context it inherited. Copied along
      // with the parent session when THAT is forked, so keyed by agentId, first
      // one wins — the two copies are byte-identical.
      if (ref?.agentId && !this.agentForkRefs.has(ref.agentId)) {
        this.agentForkRefs.set(ref.agentId, {
          contextLength: ref.contextLength,
          parentLastUuid: ref.parentLastUuid,
        });
      }
    }

    if (type === "relocated" || type === "fork-context-ref" || type === "pr-link") {
      this.queueEvent(rec, file, type, rec);
    }
  }

  /**
   * The name columns for one session.
   *
   * `nameFirst` re-runs the same precedence over the first values rather than
   * reusing whichever source won for `name`: a session can acquire an explicit
   * name partway through, and in that case its stable label is the AI title it
   * had before, not an explicit name that did not exist yet.
   */
  private namesFor(
    sessionId: string,
    meta:
      | {
          explicitFirst?: string;
          explicitLast?: string;
          aiFirst?: string;
          aiLast?: string;
          slug?: string;
        }
      | undefined,
  ): Pick<
    SessionRow,
    | "name"
    | "nameKind"
    | "nameFirst"
    | "nameChanged"
    | "customTitle"
    | "customTitleFirst"
    | "aiTitle"
    | "aiTitleFirst"
  > {
    const last = resolveSessionName(
      { explicit: meta?.explicitLast, ai: meta?.aiLast, slug: meta?.slug },
      sessionId,
    );
    const first = resolveSessionName(
      { explicit: meta?.explicitFirst, ai: meta?.aiFirst, slug: meta?.slug },
      sessionId,
    );
    return {
      name: last.name,
      nameKind: last.kind,
      nameFirst: first.name,
      nameChanged: last.name !== first.name,
      customTitle: meta?.explicitLast,
      // Only worth a column when it actually differs; otherwise it is noise.
      customTitleFirst:
        meta?.explicitFirst !== meta?.explicitLast ? meta?.explicitFirst : undefined,
      aiTitle: meta?.aiLast,
      aiTitleFirst: meta?.aiFirst !== meta?.aiLast ? meta?.aiFirst : undefined,
    };
  }

  private queueEvent(rec: Rec, file: TranscriptFile, kind: string, payload: unknown): void {
    const marked = str(rec.session_id);
    this.pendingEvents.push({
      ts: tsOf(rec),
      uuid: str(rec.uuid),
      markedOrigin: marked && marked !== str(rec.sessionId) ? marked : undefined,
      file,
      kind,
      payload: canonicalJson(payload),
    });
  }

  /** Accumulate the ordered-uuid digest a session file contributes to lineage. */
  private digestAdd(rec: Rec, file: TranscriptFile): void {
    const d = this.digestFor(file);
    d.records++;
    const uuid = str(rec.uuid);
    if (uuid) {
      d.uuids.push(uuid);
      d.ts.push(tsOf(rec));
      d.uuidSet.add(uuid);
    }
    if (str(rec.session_id)) d.markerPresent = true;
    if (isInherited(rec)) {
      d.markerInherited++;
      d.markerParent = str(rec.session_id);
      d.markerParentTs = tsOf(rec);
    }
  }

  /** Harvest image payloads off a user record, once per distinct record uuid. */
  private collectImages(rec: Rec, file: TranscriptFile): void {
    const uuid = str(rec.uuid);
    if (uuid && this.imagesByUuid.has(uuid)) return; // fork copy of the same paste
    const refs = imageRefs(rec);
    if (refs.length === 0) return;
    const sessionId = str(rec.session_id) ?? str(rec.sessionId) ?? file.fileSessionId;
    const ts = tsOf(rec);
    const rows = refs.map((i) => ({
      uuid: uuid ?? "",
      sessionId,
      ts,
      carrier: i.carrier,
      mediaType: i.mediaType,
      width: i.width,
      height: i.height,
      bytesBase64: i.base64Length,
      estTokens: i.estTokens ?? 0,
      hash: i.hash,
    }));
    this.imagesByUuid.set(uuid ?? `${sessionId}:${ts}:${rows[0].hash}`, rows);
  }

  private metaFor(sessionId: string, file: TranscriptFile) {
    let m = this.sessionMeta.get(sessionId);
    if (!m) {
      m = { hostId: file.hostId ?? "", projectSlug: file.projectSlug };
      this.sessionMeta.set(sessionId, m);
    }
    return m;
  }

  /**
   * `slug` and `cwd` describe the FILE, so they are keyed by it — the marker
   * would send a fork's own description to its parent.
   *
   * The two fields want opposite rules. `slug` is nulled on a copy, so the first
   * non-null one in a file is the file's own. `cwd` is copied verbatim, so the
   * first one belongs to the ancestor and the LAST one is this session's.
   */
  private recordSessionMeta(rec: Rec, file: TranscriptFile): void {
    const sid =
      file.kind === "session"
        ? file.fileSessionId
        : (str(rec.sessionId) ?? str(rec.session_id) ?? file.fileSessionId);
    const m = this.metaFor(sid, file);
    m.slug ??= str(rec.slug);
    m.cwd = str(rec.cwd) ?? m.cwd;
  }

  /**
   * Which session produced this record.
   *
   * `session_id` names a *link*, not a copy, and the two are not the same claim.
   * On a fork it names the session whose record this is a copy of; on a
   * continuation (`ForkKind`) every record carries it while none was copied, and
   * following it blindly would hand a whole session's spend to its predecessor.
   * So the marker is believed only when the named session's file actually
   * contains this uuid — or when that file is gone and there is nothing better.
   *
   * With no marker at all (pre-2.1.199), the same question is answered purely by
   * content: a record whose uuid already exists upstream was copied in and
   * belongs to the root-most ancestor holding it. Without that, an unmarked fork
   * is credited with everything it inherited and appears on a timeline to have
   * started days before it did.
   */
  private originFor(
    uuid: string | undefined,
    marked: string | undefined,
    own: string,
    kind: FileKind,
  ): string {
    if (marked && marked !== own) {
      const origin = this.digests.get(marked);
      if (!origin) return marked; // unverifiable: the parent's file is not here
      return uuid && origin.uuidSet.has(uuid) ? marked : own;
    }
    if (kind !== "session" || !this.lineage) return own;
    return originForRecord(this.lineage, own, uuid, this.digests);
  }

  private originOfRecord(rec: Rec, file: TranscriptFile): string {
    return this.originFor(
      str(rec.uuid),
      str(rec.session_id),
      str(rec.sessionId) ?? file.fileSessionId,
      file.kind,
    );
  }

  /** Collapse everything collected into the grains. */
  finish(): Normalized {
    // Lineage first: turn attribution depends on it (module docstring, step 3).
    const digests = [...this.digests.values()];
    const lineage = resolveLineage(digests);
    this.lineage = lineage;
    this.stats.sessionFiles = digests.length;
    this.stats.sessionFilesWithoutMarker = digests.filter((d) => !d.markerPresent).length;
    this.stats.unresolvedForks = lineage.unresolved.length;

    const lineageOf = (sessionId: string): string => lineage.lineageId.get(sessionId) ?? sessionId;

    const turns: TurnRow[] = [];
    const toolCalls: ToolCallRow[] = [];
    const images: ImageRow[] = [];

    for (const [, entry] of this.billed) {
      const row = this.turnRow(entry, lineageOf);
      if (!row) continue;
      turns.push(row);
      this.stats.dedupedOutputTokens += row.outputTokens;
      this.stats.totalCost += row.costTotal;
      if (row.unpriced) this.stats.unpricedTurns++;
      if (!row.ts) this.stats.turnsWithoutTimestamp++;
      if (row.sessionId !== row.fileSessionId && !str(entry.rec.session_id)) {
        this.stats.reattributedTurns++;
      }
      toolCalls.push(...this.toolCallRows(entry, row));
    }
    for (const rows of this.imagesByUuid.values()) images.push(...rows);

    this.stats.dedupedTurns = turns.length;
    for (const files of this.seenIn.values()) {
      if (files.size > 1) this.stats.crossFileDuplicates++;
    }

    const events = this.eventRows();
    turns.sort((a, b) => a.ts - b.ts);
    toolCalls.sort((a, b) => a.ts - b.ts);
    images.sort((a, b) => a.ts - b.ts);

    const agentRuns = this.agentRunRows(turns, lineageOf);
    const sessions = this.sessionRows(turns, events, agentRuns, lineage);
    const forkEdges = this.forkEdgeRows(sessions, lineage);
    const lineages = this.lineageRows(sessions);

    this.stats.agentRuns = agentRuns.length;
    this.stats.forkEdges = forkEdges.length;
    this.stats.forkEdgesFromMarker = forkEdges.filter((e) => e.source === "marker").length;
    this.stats.forkEdgesAmbiguous = forkEdges.filter((e) => e.ambiguous).length;
    this.stats.lineages = lineages.length;
    this.stats.maxForkDepth = sessions.reduce((m, s) => Math.max(m, s.depth), 0);

    return {
      turns,
      toolCalls,
      events,
      sessions,
      forkEdges,
      lineages,
      agentRuns,
      images,
      stats: this.stats,
    };
  }

  /**
   * Events, deduped by record uuid and attributed like turns.
   *
   * A fork copies the parent's `system` records too, so without the dedup a
   * compaction would appear once per file that carries it — and a timeline
   * would draw the same compaction on two lanes.
   */
  private eventRows(): EventRow[] {
    const seen = new Set<string>();
    const rows: EventRow[] = [];
    for (const e of this.pendingEvents) {
      const key = e.uuid ?? `${e.kind} ${e.ts} ${e.payload}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sessionId = this.originFor(e.uuid, e.markedOrigin, e.file.fileSessionId, e.file.kind);
      rows.push({
        ts: e.ts,
        sessionId,
        projectSlug: e.file.projectSlug,
        kind: e.kind,
        payload: e.payload,
      });
    }
    rows.sort((a, b) => a.ts - b.ts);
    return rows;
  }

  private turnRow(entry: BilledTurn, lineageOf: (s: string) => string): TurnRow | undefined {
    const { rec, file } = entry;
    const messageId = str(get(rec, "message.id"));
    if (!messageId) return undefined;
    const units = billableUnits(rec);
    const model = str(get(rec, "message.model"));
    const { variant } = splitModel(model);

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreate5m = 0;
    let cacheCreate1h = 0;
    let cacheReadTokens = 0;
    let webSearches = 0;
    let webFetches = 0;
    let wastedOutputTokens = 0;
    let costInput = 0;
    let costOutput = 0;
    let costCacheCreate = 0;
    let costCacheRead = 0;
    let priceable = 0;
    let priced = 0;

    const fellBack = hadFallback(rec);
    for (const u of units) {
      // A discarded fallback attempt is billed but is not the "real" turn's
      // usage; count its tokens under wasted* and still price them.
      if (fellBack && u.iterationType !== "fallback_message") wastedOutputTokens += u.output;
      inputTokens += u.input;
      outputTokens += u.output;
      cacheCreate5m += u.cache5m;
      cacheCreate1h += u.cache1h;
      // Older builds have no TTL split; keep those tokens visible under 5m.
      if (u.cache5m + u.cache1h === 0) cacheCreate5m += u.cacheCreate;
      cacheReadTokens += u.cacheRead;
      webSearches += u.webSearches;
      webFetches += u.webFetches;

      if (!u.model || UNPRICED_MODELS.has(u.model)) continue;
      priceable++;
      const p = priceUnit(this.opts.pricing, u);
      if (!p) continue;
      priced++;
      costInput += p.input;
      costOutput += p.output;
      costCacheCreate += p.cacheCreate;
      costCacheRead += p.cacheRead;
    }

    const agent = agentIdentity(rec);
    const sessionId = this.originOfRecord(rec, file);

    return {
      hostId: file.hostId ?? "",
      messageId,
      requestId: str(rec.requestId),
      uuid: str(rec.uuid),
      sessionId,
      lineageId: lineageOf(sessionId),
      fileSessionId: file.fileSessionId,
      projectSlug: file.projectSlug,
      project: projectLabel(file.projectSlug, this.slugRoot.get(file.projectSlug) ?? str(rec.cwd)),
      cwd: str(rec.cwd),
      gitBranch: str(rec.gitBranch),
      ts: tsOf(rec),
      model,
      modelVariant: variant,
      effort: str(rec.effort),
      stopReason: str(get(rec, "message.stop_reason")),
      serviceTier: str(get(rec, "message.usage.service_tier")),
      speed: str(get(rec, "message.usage.speed")),
      context: contextOf(file.kind),
      agentId: agent?.agentId ?? file.agentId,
      agentType: agent?.agentType,
      workflowId: file.workflowId,
      entrypoint: str(rec.entrypoint),
      sessionKind: str(rec.sessionKind),
      ccVersion: str(rec.version),
      attributionSkill: str(rec.attributionSkill),
      attributionPlugin: str(rec.attributionPlugin),
      attributionMcpServer: str(rec.attributionMcpServer),
      attributionMcpTool: str(rec.attributionMcpTool),
      inputTokens,
      outputTokens,
      cacheCreate5m,
      cacheCreate1h,
      cacheReadTokens,
      webSearches,
      webFetches,
      hadFallback: fellBack,
      wastedOutputTokens,
      // Unioned across the response's per-block records, not read off one.
      nBlocks: entry.blocks,
      nThinkingChars: entry.thinkingChars,
      nToolUses: entry.toolUses.length,
      // Images belong to user turns; a turn row counts none of its own.
      nImages: 0,
      estImageTokens: 0,
      aborted: isWasted(rec),
      costInput,
      costOutput,
      costCacheCreate,
      costCacheRead,
      costTotal: costInput + costOutput + costCacheCreate + costCacheRead,
      pricingVersion: this.opts.pricing.version,
      unpriced: priceable > 0 && priced === 0,
    };
  }

  private toolCallRows(entry: BilledTurn, turn: TurnRow): ToolCallRow[] {
    return entry.toolUses.map((t) => {
      const name = t.name ?? "<unnamed>";
      const isMcp = name.startsWith("mcp__");
      const result = t.id ? this.toolResults.get(t.id) : undefined;
      const outcome = result ? toolOutcome(result) : undefined;
      return {
        messageId: turn.messageId,
        toolUseId: t.id,
        sessionId: turn.sessionId,
        ts: turn.ts,
        toolName: name,
        isMcp,
        mcpServer: isMcp ? name.split("__")[1] : undefined,
        context: turn.context,
        ok: outcome?.ok,
        interrupted: outcome?.interrupted,
        errorKind: outcome?.error ? outcome.error.slice(0, 120) : undefined,
        exitCode: outcome?.exitCode,
        durationMs: outcome?.durationMs,
      };
    });
  }

  /**
   * One row per agent instance, materialised rather than left as a GROUP BY.
   *
   * The group-by is easy in isolation (`GROUP BY agentId`), but a cross-filtered
   * dashboard would have to re-run it inside every brushed query, and two of the
   * columns are not in `turns` at all: `workflowId` comes from the file path and
   * the `fork-context-ref` fields come from a record type that carries no usage.
   * A few hundred rows is a cheap price for a table a timeline can mark directly.
   */
  private agentRunRows(turns: TurnRow[], lineageOf: (s: string) => string): AgentRunRow[] {
    const byAgent = new Map<string, TurnRow[]>();
    for (const t of turns) {
      if (!t.agentId || t.context === "main") continue;
      const list = byAgent.get(t.agentId);
      if (list) list.push(t);
      else byAgent.set(t.agentId, [t]);
    }
    const rows: AgentRunRow[] = [];
    for (const [agentId, list] of byAgent) {
      list.sort((a, b) => a.ts - b.ts);
      const meta = this.agentMeta.get(agentId);
      const ref = this.agentForkRefs.get(agentId);
      const models = new Set<string>();
      let cost = 0;
      let nToolUses = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let agentType: string | undefined;
      for (const t of list) {
        if (t.model) models.add(t.model);
        agentType ??= t.agentType;
        cost += t.costTotal;
        nToolUses += t.nToolUses;
        inputTokens += t.inputTokens;
        outputTokens += t.outputTokens;
        cacheReadTokens += t.cacheReadTokens;
      }
      const firstTs = list[0].ts;
      const lastTs = list[list.length - 1].ts;
      // The turn's own sessionId is the launching session even on a fork copy
      // (subagent records keep the original `sessionId`), so it beats the
      // directory the file happens to sit in.
      const parentSessionId = list[0].sessionId || (meta?.dirSessionId ?? "");
      const label = agentNameOf(agentId, agentType);
      rows.push({
        agentId,
        agentType,
        name: label.name,
        nameKind: label.kind,
        parentSessionId,
        lineageId: lineageOf(parentSessionId),
        projectSlug: meta?.projectSlug ?? list[0].projectSlug,
        project: list[0].project,
        context: meta?.context ?? list[0].context,
        workflowId: meta?.workflowId ?? list[0].workflowId,
        firstTs,
        lastTs,
        spanSeconds: Math.max(0, (lastTs - firstTs) / 1000),
        nTurns: list.length,
        nToolUses,
        cost,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        models: [...models].sort().join(","),
        inheritedContextLength: ref?.contextLength,
        parentLastUuid: ref?.parentLastUuid,
      });
    }
    rows.sort((a, b) => a.firstTs - b.firstTs);
    return rows;
  }

  /**
   * Sessions are derived from the deduped turns plus the file digests, so a fork
   * contributes only the turns it actually produced — and a fork that produced
   * none still gets a row, because "this fork happened and went nowhere" is a
   * thing a timeline has to be able to draw.
   *
   * `activeSeconds` sums inter-turn gaps below the idle threshold, over *native*
   * turns only, or a fork would inherit its ancestor's elapsed time and report a
   * nonsense duty cycle.
   */
  private sessionRows(
    turns: TurnRow[],
    events: EventRow[],
    agentRuns: AgentRunRow[],
    lineage: LineageResolution,
  ): SessionRow[] {
    const bySession = new Map<string, TurnRow[]>();
    for (const t of turns) {
      const list = bySession.get(t.sessionId);
      if (list) list.push(t);
      else bySession.set(t.sessionId, [t]);
    }
    // uuid → the session that paid for it, so a digest can be walked once to
    // find the turns it merely carried (linear, not sessions × turns).
    const turnByUuid = new Map<string, TurnRow>();
    for (const t of turns) if (t.uuid) turnByUuid.set(t.uuid, t);

    const compactionsBySession = new Map<string, { n: number; peak: number }>();
    for (const e of events) {
      if (e.kind !== "compaction") continue;
      const c = compactionsBySession.get(e.sessionId) ?? { n: 0, peak: 0 };
      c.n++;
      const pre = num(obj(JSON.parse(e.payload))?.preTokens);
      c.peak = Math.max(c.peak, pre);
      compactionsBySession.set(e.sessionId, c);
    }
    const agentsBySession = new Map<string, number>();
    for (const a of agentRuns) {
      agentsBySession.set(a.parentSessionId, (agentsBySession.get(a.parentSessionId) ?? 0) + 1);
    }

    const gapMs = this.opts.idleGapSeconds * 1000;
    const ids = new Set<string>([...bySession.keys(), ...this.digests.keys()]);
    const rows: SessionRow[] = [];
    for (const sessionId of ids) {
      const list = bySession.get(sessionId) ?? [];
      list.sort((a, b) => a.ts - b.ts);
      const meta = this.sessionMeta.get(sessionId);
      const digest = this.digests.get(sessionId);
      const edge = lineage.edges.get(sessionId);

      let activeMs = 0;
      for (let i = 1; i < list.length; i++) {
        const d = list[i].ts - list[i - 1].ts;
        if (d > 0 && d < gapMs) activeMs += d;
      }
      const firstTs = list.length ? list[0].ts : undefined;
      const lastTs = list.length ? list[list.length - 1].ts : undefined;
      const spanSeconds = firstTs && lastTs ? Math.max(0, (lastTs - firstTs) / 1000) : 0;
      const activeSeconds = activeMs / 1000;
      const models = new Set<string>();
      const versions = new Set<string>();
      let nativeCost = 0;
      let nSubagentTurns = 0;
      const compactions = compactionsBySession.get(sessionId);
      let peakContext = compactions?.peak ?? 0;
      for (const t of list) {
        if (t.model) models.add(t.model);
        if (t.ccVersion) versions.add(t.ccVersion);
        nativeCost += t.costTotal;
        if (t.context !== "main") nSubagentTurns++;
        // cache_read is the prefix that was re-sent — a good proxy for context
        // size at that turn. Validated against compactMetadata.preTokens.
        peakContext = Math.max(peakContext, t.cacheReadTokens);
      }

      // What this file carries but did not pay for.
      let nTurnsInherited = 0;
      let inheritedCost = 0;
      const inheritedRecords = edge?.inheritedRecords ?? 0;
      if (digest && inheritedRecords > 0) {
        for (let i = 0; i < inheritedRecords; i++) {
          const t = turnByUuid.get(digest.uuids[i]);
          if (t && t.sessionId !== sessionId) {
            nTurnsInherited++;
            inheritedCost += t.costTotal;
          }
        }
      }
      const firstNativeIdx = inheritedRecords;

      rows.push({
        // Sessions do not span machines, so any turn's host is the session's.
        hostId: list[0]?.hostId ?? meta?.hostId ?? "",
        sessionId,
        projectSlug: meta?.projectSlug ?? digest?.projectSlug ?? list[0]?.projectSlug ?? "",
        project: projectLabel(
          meta?.projectSlug ?? digest?.projectSlug ?? list[0]?.projectSlug ?? "",
          this.slugRoot.get(meta?.projectSlug ?? digest?.projectSlug ?? "") ?? meta?.cwd,
        ),
        cwd: meta?.cwd ?? list[0]?.cwd,
        slug: meta?.slug,
        ...this.namesFor(sessionId, meta),
        parentSessionId: edge?.parentSessionId,
        lineageId: lineage.lineageId.get(sessionId) ?? sessionId,
        depth: lineage.depth.get(sessionId) ?? 0,
        forkPointTs: edge?.forkPointTs,
        parentSource: edge?.source,
        parentKind: edge?.kind,
        parentAmbiguous: edge?.ambiguous ?? false,
        nRecordsInherited: inheritedRecords,
        nTurnsInherited,
        inheritedCost,
        createdTs: digest?.createdMs,
        firstNativeTs:
          digest && firstNativeIdx < digest.ts.length ? digest.ts[firstNativeIdx] : undefined,
        lastNativeTs: digest?.ts.length ? digest.ts[digest.ts.length - 1] : undefined,
        firstTs,
        lastTs,
        spanSeconds,
        activeSeconds,
        dutyCycle: !list.length ? undefined : spanSeconds > 0 ? activeSeconds / spanSeconds : 1,
        nTurnsNative: list.length,
        nSubagentTurns,
        nAgentRuns: agentsBySession.get(sessionId) ?? 0,
        nCompactions: compactions?.n ?? 0,
        peakContextTokens: peakContext,
        nativeCost,
        models: [...models].sort().join(","),
        ccVersions: [...versions].sort().join(","),
      });
    }
    rows.sort((a, b) => (a.firstTs || a.createdTs || 0) - (b.firstTs || b.createdTs || 0));
    return rows;
  }

  private forkEdgeRows(sessions: SessionRow[], lineage: LineageResolution): ForkEdgeRow[] {
    const bySession = new Map(sessions.map((s) => [s.sessionId, s]));
    const rows: ForkEdgeRow[] = [];
    for (const [childId, e] of lineage.edges) {
      const child = bySession.get(childId);
      if (!child) continue;
      // The child's own first activity is the honest far endpoint; its file
      // birthtime is the fallback for a fork that never produced anything.
      const childStart = child.firstNativeTs || e.childCreatedTs || child.firstTs;
      const parent = bySession.get(e.parentSessionId);
      const anchor = this.billedAnchor(childId, lineage, bySession);
      rows.push({
        childSessionId: childId,
        parentSessionId: e.parentSessionId,
        lineageId: child.lineageId,
        depth: child.depth,
        projectSlug: child.projectSlug,
        project: child.project,
        kind: e.kind,
        forkPointTs: e.forkPointTs,
        childCreatedTs: e.childCreatedTs,
        childFirstNativeTs: e.childFirstNativeTs,
        lagSeconds: childStart && e.forkPointTs ? (childStart - e.forkPointTs) / 1000 : 0,
        nRecordsInherited: e.inheritedRecords,
        nTurnsInherited: child.nTurnsInherited,
        inheritedCost: child.inheritedCost,
        source: e.source,
        ambiguous: e.ambiguous,
        parentMissing: e.parentMissing,
        parentHasTurns: (parent?.nTurnsNative ?? 0) > 0,
        childHasTurns: child.nTurnsNative > 0,
        billedAncestorSessionId: anchor?.sessionId,
        billedAncestorForkPointTs: anchor?.ts,
      });
    }
    rows.sort((a, b) => a.forkPointTs - b.forkPointTs);
    return rows;
  }

  /**
   * Walk up from a child's parent to the first ancestor with a billed turn, and
   * ask the branch-point question of *that* ancestor. See `ForkEdgeRow`.
   */
  private billedAnchor(
    childId: string,
    lineage: LineageResolution,
    bySession: Map<string, SessionRow>,
  ): { sessionId: string; ts: number } | undefined {
    const chain = lineage.chain.get(childId);
    const child = this.digests.get(childId);
    if (!chain || !child) return undefined;
    // chain is [root, …, parent, self]; nearest first means walking backwards.
    for (let i = chain.length - 2; i >= 0; i--) {
      const id = chain[i];
      if ((bySession.get(id)?.nTurnsNative ?? 0) === 0) continue;
      const ancestor = this.digests.get(id);
      if (!ancestor) continue;
      return { sessionId: id, ts: branchPoint(child, ancestor).ts };
    }
    return undefined;
  }

  private lineageRows(sessions: SessionRow[]): LineageRow[] {
    const byLineage = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      const list = byLineage.get(s.lineageId);
      if (list) list.push(s);
      else byLineage.set(s.lineageId, [s]);
    }
    const rows: LineageRow[] = [];
    for (const [lineageId, list] of byLineage) {
      list.sort((a, b) => a.depth - b.depth || (a.createdTs ?? 0) - (b.createdTs ?? 0));
      const root = list.find((s) => s.depth === 0) ?? list[0];
      let firstTs = Infinity;
      let lastTs = 0;
      let totalCost = 0;
      let nTurns = 0;
      let maxDepth = 0;
      for (const s of list) {
        const lo = s.firstNativeTs || s.firstTs || s.createdTs || 0;
        const hi = Math.max(s.lastNativeTs ?? 0, s.lastTs ?? 0);
        if (lo) firstTs = Math.min(firstTs, lo);
        lastTs = Math.max(lastTs, hi);
        totalCost += s.nativeCost;
        nTurns += s.nTurnsNative;
        maxDepth = Math.max(maxDepth, s.depth);
      }
      rows.push({
        lineageId,
        rootSessionId: root.sessionId,
        projectSlug: root.projectSlug,
        project: root.project,
        nSessions: list.length,
        nForks: list.length - 1,
        maxDepth,
        firstTs: Number.isFinite(firstTs) ? firstTs : 0,
        lastTs,
        nTurns,
        totalCost,
        sessionIds: list.map((s) => s.sessionId).join(","),
      });
    }
    rows.sort((a, b) => a.firstTs - b.firstTs);
    return rows;
  }
}
