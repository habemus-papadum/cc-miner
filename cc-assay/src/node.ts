/**
 * Node-only entry point: filesystem scanning, pricing fetch, Parquet output.
 *
 * Split from the barrel so the pure half (`fields`, `images`, `pricing`
 * arithmetic, `normalize`) stays importable from a browser bundle — the demo
 * reuses `TRAPS` and `DIMENSIONS` for its own UI copy.
 */

export * from "./parquet.ts";
export type { RunOptions, RunResult } from "./run.ts";
export { loadPriceTable, normalizeCorpus } from "./run.ts";
export * from "./scan.ts";
