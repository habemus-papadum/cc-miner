/**
 * The replay grain: one row per conversational *block*, per session.
 *
 * This is the finest drill-down — "what the hell was going on in this hour" —
 * and it is the reason stage 1 keeps message bodies that `normalize.ts`
 * deliberately throws away.
 *
 * ## Why it is partitioned per session
 *
 * The content does not fit in one table. Measured across the corpus:
 *
 * | block | count | content |
 * | --- | ---: | ---: |
 * | `tool_result` | 39,138 | **112 MB** |
 * | `text` | 13,036 | 8 MB |
 * | user prompt | 2,226 | 7 MB |
 * | `tool_use` | 39,138 | ~30 MB |
 *
 * Even truncated that is tens of megabytes, and the page already loads 5.5 MB
 * of analytic grains before it draws anything. But a replay is *always* scoped
 * to one session — you never read all 109 at once — so it ships as
 * `replay/<sessionId>.parquet` and the viewer fetches the one it needs. The
 * biggest session in this corpus lands around 2 MB.
 *
 * ## Which bytes are kept
 *
 * Prompts and assistant text survive in full: they are 15 MB together and they
 * are the story. Tool inputs and results are truncated hard, because they are
 * 140 MB and the first few hundred characters carry the meaning — a `Bash`
 * command, an error's first line. Every truncated row records its true length,
 * so the view can say "showing 600 of 48,000 characters" rather than pretend.
 *
 * `file-history-snapshot` and `attachment` records are dropped entirely (24% of
 * one session's bytes). They are editor state, not conversation.
 *
 * ## Thinking text does not exist
 *
 * 20,784 `thinking` blocks in this corpus and **every one has
 * `thinking: ""`** — only the encrypted `signature` is retained. So a replay
 * can show *that* the model thought, and what that cost in output tokens, but
 * never what it thought. Rows are still emitted, because "it thought here" is
 * itself part of reading a session back.
 *
 * ## Keyed by FILE, not by attributed session
 *
 * Unlike the analytic grains, replay does not re-attribute a forked prefix to
 * its originating session. Replaying session X means reading X's transcript top
 * to bottom — the inherited prefix included, because that is what the session
 * actually looked like from the inside. Billing needs the attribution; reading
 * does not, and applying it here would delete the first half of every fork.
 */

import { arr, get, obj, type Rec, str, toolOutcome, toolSummary } from "./fields.ts";
import type { TranscriptFile } from "./scan.ts";

/** Tool inputs and results are truncated to these; prompts and text are not. */
export const TOOL_INPUT_CHARS = 400;
export const TOOL_RESULT_CHARS = 800;

/** Records that carry editor state rather than conversation. */
const SKIP_TYPES = new Set(["file-history-snapshot", "file-history-delta", "attachment"]);

export interface ReplayRow {
  /** The session FILE this row belongs to — see the note on attribution above. */
  sessionId: string;
  /** Absent on the main loop; the per-instance id of a subagent or workflow agent. */
  agentId?: string;
  /** `main` | `subagent` | `workflow-agent` | `workflow-journal`. */
  context: string;
  /** Stable order within (sessionId, agentId): file line, then block index. */
  seq: number;
  ts: number;
  uuid?: string;
  parentUuid?: string;
  /** `user` | `assistant` | `system`. */
  role: string;
  /** `prompt` | `text` | `thinking` | `tool_use` | `tool_result` | `image` | `compaction` | … */
  kind: string;
  /** The content, truncated for tool kinds. */
  text?: string;
  /** True when `text` was cut — the view must say so rather than imply completeness. */
  truncated: boolean;
  /** Length before truncation, so "600 of 48,000" is sayable. */
  fullChars: number;
  toolName?: string;
  toolUseId?: string;
  /** Tool outcome, joined from the matching `tool_result`. */
  ok?: boolean;
  errorKind?: string;
  exitCode?: number;
  durationMs?: number;
  model?: string;
}

const cut = (s: string, max: number): { text: string; truncated: boolean; fullChars: number } =>
  s.length <= max
    ? { text: s, truncated: false, fullChars: s.length }
    : { text: s.slice(0, max), truncated: true, fullChars: s.length };

/** `tool_result.content` is a string or a list of blocks; flatten to text. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const b of arr(content)) {
    const o = obj(b);
    if (!o) continue;
    const t = str(o.text);
    if (t) parts.push(t);
    else if (o.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

/**
 * Accumulates replay rows, one session at a time.
 *
 * Fed from the same record stream as `Normalizer` — order within a file is what
 * makes `seq` meaningful, and both ingest paths already guarantee it.
 */
export class ReplayBuilder {
  private readonly bySession = new Map<string, ReplayRow[]>();
  private seq = 0;

  /** sessionId → rows, in file order. */
  get sessions(): ReadonlyMap<string, ReplayRow[]> {
    return this.bySession;
  }

  get rowCount(): number {
    let n = 0;
    for (const rows of this.bySession.values()) n += rows.length;
    return n;
  }

  private push(row: ReplayRow): void {
    const list = this.bySession.get(row.sessionId);
    if (list) list.push(row);
    else this.bySession.set(row.sessionId, [row]);
  }

  add(rec: Rec, file: TranscriptFile): void {
    const type = str(rec.type);
    if (!type || SKIP_TYPES.has(type)) return;

    const base = {
      sessionId: file.fileSessionId,
      ...(file.agentId ? { agentId: file.agentId } : {}),
      context: file.kind === "session" ? "main" : file.kind,
      ts: Date.parse(str(rec.timestamp) ?? "") || 0,
      ...(str(rec.uuid) ? { uuid: str(rec.uuid) } : {}),
      ...(str(rec.parentUuid) ? { parentUuid: str(rec.parentUuid) } : {}),
    };

    // A compaction is a landmark in a replay: it is where the earlier half of
    // the conversation stopped being visible to the model.
    const compact = obj(get(rec, "compactMetadata"));
    if (compact) {
      this.push({
        ...base,
        seq: this.seq++,
        role: "system",
        kind: "compaction",
        text: `${str(compact.trigger) ?? "auto"}: ${compact.preTokens} → ${compact.postTokens} tokens`,
        truncated: false,
        fullChars: 0,
      });
      return;
    }

    if (type !== "user" && type !== "assistant") return;

    const model = str(get(rec, "message.model"));
    const content = get(rec, "message.content");

    // A plain-string user message is a typed prompt. Kept in full — 2,226 of
    // them across the corpus and they are what the session was *for*.
    if (typeof content === "string") {
      const t = content.trim();
      if (t) {
        this.push({
          ...base,
          seq: this.seq++,
          role: "user",
          kind: "prompt",
          text: t,
          truncated: false,
          fullChars: t.length,
        });
      }
      return;
    }

    for (const block of arr(content)) {
      const b = obj(block);
      if (!b) continue;
      const kind = str(b.type) ?? "?";
      const row: ReplayRow = {
        ...base,
        seq: this.seq++,
        role: type,
        kind,
        truncated: false,
        fullChars: 0,
        ...(model ? { model } : {}),
      };

      if (kind === "text") {
        const t = (str(b.text) ?? "").trim();
        if (!t) continue;
        Object.assign(row, { text: t, fullChars: t.length });
        // A user's `text` block is a prompt too — the array form appears when
        // the message carries an image or a pasted attachment beside it.
        if (type === "user") row.kind = "prompt";
      } else if (kind === "thinking") {
        // Always empty; see the module note. The row records that it happened.
        Object.assign(row, { fullChars: (str(b.thinking) ?? "").length });
      } else if (kind === "tool_use") {
        const name = str(b.name);
        const summary = toolSummary(name, b.input) ?? JSON.stringify(b.input ?? {});
        Object.assign(row, {
          ...cut(summary, TOOL_INPUT_CHARS),
          toolName: name,
          toolUseId: str(b.id),
        });
      } else if (kind === "tool_result") {
        // Two independent signals of failure and they do not always agree:
        // `is_error` is the block's own flag, `toolUseResult.success` is the
        // tool's. Either one saying no means no — a replay's job is to make a
        // failure findable, so the pessimistic read is the right one.
        const out = toolOutcome(rec);
        const failed = b.is_error === true || out?.ok === false || out?.interrupted === true;
        Object.assign(row, {
          ...cut(resultText(b.content), TOOL_RESULT_CHARS),
          toolUseId: str(b.tool_use_id),
          ...(failed ? { ok: false } : out?.ok === true ? { ok: true } : {}),
          ...(out?.error ? { errorKind: out.error.slice(0, 200) } : {}),
          ...(out?.exitCode !== undefined ? { exitCode: out.exitCode } : {}),
          ...(out?.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
        });
      } else if (kind === "image") {
        Object.assign(row, { text: str(get(b, "source.media_type")) ?? "image" });
      } else {
        Object.assign(row, cut(JSON.stringify(b), TOOL_INPUT_CHARS));
      }
      this.push(row);
    }
  }
}
