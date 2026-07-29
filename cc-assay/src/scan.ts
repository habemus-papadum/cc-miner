/**
 * Finding and streaming Claude Code transcript files.
 *
 * Claude Code writes four file shapes under `~/.claude/projects/<slug>/`:
 *
 *   <sessionId>.jsonl                                     — the main transcript
 *   <sessionId>/subagents/agent-<id>.jsonl                — one per Task subagent
 *   <sessionId>/subagents/workflows/wf_<id>/agent-*.jsonl — Workflow agents
 *   <sessionId>/subagents/workflows/wf_<id>/journal.jsonl — the workflow journal
 *
 * A tool that only globs `<slug>/*.jsonl` sees the first shape and silently
 * omits every subagent's tokens — 29.6% of assistant records on the baseline
 * corpus. Hence the recursive walk.
 */

import type { Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Rec } from "./fields.ts";

export type FileKind = "session" | "subagent" | "workflow-agent" | "workflow-journal";

export interface TranscriptFile {
  path: string;
  /** Directory name under `projects/` — the cwd with `/` replaced by `-`. */
  projectSlug: string;
  /** Session id taken from the *path*, which can differ from a record's own. */
  fileSessionId: string;
  kind: FileKind;
  bytes: number;
  /**
   * File birthtime in ms, when the filesystem records one.
   *
   * The only place this package reads metadata rather than content, and it earns
   * its keep twice: a fork's file is created at the moment of the fork, so this
   * is the honest wall-clock position of a fork even when the fork went on to
   * produce nothing; and it is the last-resort tiebreak when two files hold the
   * same leading records and content cannot say which is the copy (see
   * `lineage.ts`). Left undefined where the platform has no birthtime, so a
   * lineage that would have to guess reports itself unresolved instead.
   */
  createdMs?: number;
  /** `agent-<id>.jsonl` → `<id>`. Present on subagent and workflow-agent files. */
  agentId?: string;
  /** `wf_<id>` path segment, on workflow agents and their journal. */
  workflowId?: string;
  /**
   * Which machine the file came from. Undefined when walking the filesystem
   * directly — there is only one machine in that case — and set from the raw
   * layer's `host.json` when reading a host set, which is what lets the
   * analytic grains be filtered by host.
   */
  hostId?: string;
}

/**
 * Default transcript roots. `CLAUDE_CONFIG_DIR` may name one path or several
 * comma-separated; both `~/.claude` and `~/.config/claude` are used in the wild.
 */
export function defaultRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured) {
    return configured
      .split(",")
      .map((p) => path.join(p.trim(), "projects"))
      .filter(Boolean);
  }
  return [
    path.join(homedir(), ".claude", "projects"),
    path.join(homedir(), ".config", "claude", "projects"),
  ];
}

function kindOf(rel: string[], name: string): FileKind {
  if (rel.length === 0) return "session";
  if (name === "journal.jsonl") return "workflow-journal";
  if (rel.includes("workflows")) return "workflow-agent";
  return "subagent";
}

/** Recursively enumerate every transcript file under one `projects/` root. */
export async function* findTranscripts(root: string): AsyncGenerator<TranscriptFile> {
  let projects: Dirent[];
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return; // a configured root that does not exist is not an error
  }
  for (const p of projects.sort(byName)) {
    if (!p.isDirectory()) continue;
    yield* walk(path.join(root, p.name), p.name, []);
  }
}

const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

async function* walk(
  dir: string,
  projectSlug: string,
  rel: string[],
): AsyncGenerator<TranscriptFile> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort(byName)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full, projectSlug, [...rel, e.name]);
      continue;
    }
    if (!e.name.endsWith(".jsonl")) continue;
    // The session id is the first path segment below the project slug: either
    // `<sessionId>.jsonl` itself, or the `<sessionId>/` directory we descended.
    const fileSessionId = rel.length === 0 ? e.name.slice(0, -".jsonl".length) : rel[0];
    let bytes = 0;
    let createdMs: number | undefined;
    try {
      const st = await stat(full);
      bytes = st.size;
      // ext4 without statx reports 0; an epoch birthtime is worse than none.
      // Floored: APFS reports fractional milliseconds, but the raw layer stores
      // this as an INT64, so keeping the fraction here would make a value
      // derived from it (`lagSeconds`) disagree between the two ingest paths
      // over sub-millisecond noise. Whole milliseconds are already finer than
      // anything lineage asks of a birthtime.
      createdMs = st.birthtimeMs > 0 ? Math.floor(st.birthtimeMs) : undefined;
    } catch {
      /* raced with a delete; a zero size is fine for stats */
    }
    const wf = rel.indexOf("workflows");
    yield {
      path: full,
      projectSlug,
      fileSessionId,
      kind: kindOf(rel, e.name),
      bytes,
      createdMs,
      agentId: e.name.startsWith("agent-")
        ? e.name.slice("agent-".length, -".jsonl".length)
        : undefined,
      workflowId: wf >= 0 ? rel[wf + 1] : undefined,
    };
  }
}

/**
 * Stream one file's records. Malformed lines are counted, never thrown —
 * a half-written final line in the *currently active* session is normal.
 */
export async function* readRecords(file: string, onParseError?: () => void): AsyncGenerator<Rec> {
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      onParseError?.();
      continue;
    }
    if (rec && typeof rec === "object" && !Array.isArray(rec)) yield rec as Rec;
  }
}

/**
 * The project slug is the absolute cwd with `/` → `-`; invert it for display.
 * Lossy — an underscore in a directory name was already encoded as `-` — so
 * this is only ever a fallback when the record carries no `cwd`.
 */
export const slugToPath = (slug: string): string => slug.replace(/-/g, "/");

/**
 * A short, human-usable project label.
 *
 * Naively this is the last path segment of `cwd`, but that is wrong for
 * worktrees, and badly so: Claude Code runs worktree-isolated subagents in
 * `<repo>/.claude/worktrees/agent-<id>`, which turns every subagent into its
 * own "project" — 108 labels for 18 repositories on the baseline corpus, and a
 * chart legend nobody can read.
 *
 * So everything from `/.claude/` onward is dropped first, collapsing both
 * agent-isolation worktrees and named ones back onto the repository they belong
 * to. The branch stays separately available as `gitBranch`, which is the column
 * that should distinguish worktrees when a view wants to.
 */
export function projectLabel(slug: string, cwd?: string): string {
  const parts = repoRoot(cwd ?? slugToPath(slug))
    .split("/")
    .filter(Boolean);
  return parts.at(-1) ?? slug;
}

/** Strip any worktree suffix, leaving the repository a cwd belongs to. */
export const repoRoot = (cwd: string): string => cwd.split("/.claude/")[0];
