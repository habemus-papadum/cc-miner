/**
 * corpus-dir.ts — the ONE definition of where a mined corpus lives.
 *
 * A corpus is personal telemetry: conversation text, project names, branch
 * names, working directory paths. It belongs on the machine that produced it
 * and nowhere else — so it lives in the user's cache directory, never in the
 * repository and never inside a build artifact.
 *
 * That was not always true. `src/data` used to sit in the working tree, and
 * `src/model/source.ts` pulled it into the renderer with an EAGER
 * `import.meta.glob`, which is resolved at BUILD time — so `vite build` emitted
 * every Parquet file as a hashed asset and a packaged `.dmg` carried the
 * builder's own transcripts. Measured on a real corpus: 121 session replay
 * files in `dist/assets`, `app.asar` 89.6 MB → 128.5 MB. The `.gitignore`
 * protected the repository and nothing protected the artifact.
 *
 * Keeping the path here, rather than as a default argument in four places,
 * is what makes "the app and the miner agree about where the data is" a fact
 * instead of a convention. Everything that reads or writes a corpus — the
 * miner, the DuckDB host, the Vite plugin that serves it to a browser, and the
 * Electron sidecar — resolves it through this function.
 *
 * Precedence, highest first:
 *   1. `PDUM_CC_MINER_CORPUS` — an explicit override, for a corpus elsewhere
 *   2. `XDG_CACHE_HOME/cc-miner` — honoured where it is set
 *   3. `~/.cache/cc-miner` — the default, on every platform
 *
 * Deliberately NOT platform-conventional (`~/Library/Caches` on macOS): the
 * same path has to be typeable in a shell command, a README, and an error
 * message on any machine, and one spelling is worth more than native placement
 * for a directory users are expected to point tools at.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** The directory holding the Hive-partitioned corpus the app reads. */
export function corpusDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PDUM_CC_MINER_CORPUS?.trim();
  if (override) return override;
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg) return join(xdg, "cc-miner");
  return join(homedir(), ".cache", "cc-miner");
}

/**
 * Where the miner puts its intermediate FLAT grains (`turns.parquet`, …).
 *
 * Kept separate from the corpus itself, and that separation is load-bearing:
 * the app globs `<grain>/username=*​/host=*​/**​/*.parquet`, so a flat corpus
 * dropped in the corpus directory does not merely fail — it fails obscurely,
 * reporting `no "turns" grain (it reported: … turns.parquet)` because the grain
 * name is derived from the first path segment. Two shapes, two directories.
 */
export function stagingDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(corpusDir(env), ".staging");
}
