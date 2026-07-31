/**
 * `@habemus-papadum/cc-assay` — reading, normalizing and pricing Claude
 * Code session transcripts.
 *
 * The schema knowledge lives in `fields.ts` and is the point of this package:
 * lenient accessors plus an encoded registry of categorical dimensions
 * (`DIMENSIONS`) and known traps (`TRAPS`). The full design is the
 * `claude-code-usage-analytics` proposal, upstream in pdum_aiui's
 * `docs/proposals/`.
 *
 * This barrel is environment-free. Anything touching the filesystem lives
 * behind the `./node` subpath.
 */
export * from "./fields.ts";
export * from "./grains.ts";
export * from "./images.ts";
export * from "./invariants.ts";
export * from "./lineage.ts";
export * from "./normalize.ts";
export * from "./pricing.ts";
