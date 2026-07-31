/**
 * corpus.ts — what a mined corpus contains, and the shapes it reports.
 *
 * Constants and types only: no engine, no Mosaic, no Solid. Split out of
 * store.ts so a reader asking "what grains are there / what does the manifest
 * say" does not have to walk past the boot sequence to find out.
 */

/** The five grains every version of the normalizer writes. */
export const TABLES = {
  turns: true,
  toolCalls: true,
  events: true,
  sessions: true,
  images: true,
} as const;

/**
 * Grains the normalizer grew later — fork lineage and per-agent runs.
 *
 * Optional because a corpus normalised before they existed simply has no such
 * files, and the host reports which grains it actually resolved. The app runs
 * without them; listing them as required would turn a stale dataset into a
 * blank page, and the sessions are the point even when the lineage is absent.
 */
export const OPTIONAL_TABLES = {
  forkEdges: true,
  agentRuns: true,
  lineages: true,
} as const;

export type TableName = keyof typeof TABLES | keyof typeof OPTIONAL_TABLES;

/** What the normalizer recorded about the run that produced this data. */
export interface Manifest {
  generatedAt: string;
  pricing: { source: string; version: string };
  stats: {
    files: number;
    records: number;
    assistantRecords: number;
    dedupedTurns: number;
    naiveOutputTokens: number;
    dedupedOutputTokens: number;
    crossFileDuplicates: number;
    totalCost: number;
    unpricedTurns: number;
  };
  invariants: { ok: boolean; problems: string[] };
}

export interface CorpusSummary {
  turns: number;
  sessions: number;
  projects: number;
  firstTs: number;
  lastTs: number;
  totalCost: number;
  costInput: number;
  costOutput: number;
  costCacheCreate: number;
  costCacheRead: number;
}

export interface LoadProgress {
  /** 0..1 through the boot steps, or null when the step has no measure. */
  fraction: number | null;
  label: string;
}
