# Recorded for later

Real findings, verified, deliberately **not** being acted on now. Kept so the evidence does not have
to be rediscovered — several of these cost a full review pass to establish.

Current agreed work is in [`PLAN.md`](./PLAN.md), designed in
[`ARCHITECTURE.md`](./ARCHITECTURE.md); the completed cleanup pass is
[`CLEANUP-PLAN.md`](./CLEANUP-PLAN.md), whose § numbers the notes below refer to. Things turned down
outright are in
[`DECLINED.md`](./DECLINED.md). file:line references are from `d406ddf`.

---

## Extraction — deferred entirely

[`EXTRACTION.md`](./EXTRACTION.md) holds the full inventory for pulling out `aiui-electron`,
`aiui-duckdb-host` and `quackConnector`: every file and export that moves, ~30 cc-miner couplings
with proposed option names, 25 load-bearing behaviours with the reason each exists, and 10 blockers.

**No extraction work is planned.** Two things from that document matter even if extraction never
happens, because they are wrong *now*:

- `DEPLOYMENT.md` §3 claims of `aiui-electron` that "none of it mentions cc-miner". **False** —
  eight `PDUM_CC_MINER_*` env vars, a hardcoded `app://pdum-cc-miner`, `app.setName`, the window
  title, the `#14161a` background, and product strings in the updater dialog.
- `electron-builder.yml`'s `files` allowlist excludes `@habemus-papadum/**`. Anything moved into
  such a package would be **excluded from the packaged app** — typechecks, passes in dev, fails at
  `require` time inside the `.dmg`. This also blocks running the miner from the UI (see below).

---

## Dependency prune — keeping them, will use later

### Root `devDependencies`

Verified unused today, kept anyway:

- **The docs cluster** — `mermaid`, `typedoc`, `typedoc-plugin-markdown`, `typedoc-vitepress-theme`,
  `vitepress`, `vitepress-plugin-mermaid`. Zero references repo-wide: no `docs/`, no `.vitepress/`,
  no `typedoc.json`, no docs script in any manifest, no ```` ```mermaid ```` fence in any markdown,
  and neither workflow builds docs.
- **Duplicates every consumer already declares** — `tsx`, `vite`, `vitest`, `typescript`,
  `typescript-language-server`. Each is declared in `cc-assay/package.json:38-40` and/or
  `pdum-cc-miner/package.json:60-64`; pnpm's isolated layout means nothing resolves them from root.

Removing all eleven was verified green in a scratch copy: `upstream:check`, `lint`, `typecheck`,
`test` (65 + 132), and `pnpm -C pdum-cc-miner build`. The only behaviour lost is root
`pnpm exec tsc` / `vitest`.

**Prerequisite when this happens:** declare `@types/node` in both subpackages first — that part is
in `CLEANUP-PLAN.md` §6, precisely because it is the trap that fires otherwise.

### `pdum-cc-miner` — keeping, will be used later

- **`@habemus-papadum/cc-assay`** (`package.json:45`) — zero imports today. Note the one place it
  *would* be used documents why it must not be: `server/host-runtime.mjs:51-55` duplicates
  `corpusDir()` deliberately, because the packaged bundle prunes `node_modules` to the
  `electron-builder.yml` allowlist. If this dependency starts being used, that constraint still
  applies.
- **`typescript-language-server`** (`:61`) — no reference in any script or config; also at root.
- **The `normalize` script** (`:27`) — kept. Its `--out` target (`src/data`) no longer exists and it
  writes a layout the app cannot read, so it is currently a trap for anyone who runs it. `CLEANUP-PLAN.md` §2
  fixes the *documentation* that points people at it; the script itself stays.

### Do not remove these when the prune happens

- **`@babel/core`** — redundant today (satisfied transitively via `vite-plugin-solid`), but the only
  thing pinning an optional peer of `@habemus-papadum/aiui-source-processor`, whose absence breaks
  the aiui compiler pass.
- **`jsdom`** — config-only, `vitest.config.ts:26`.
- **`@habemus-papadum/aiui`** — used as a *binary* (`aiui claude`, `aiui open`), never imported.
- The renderer packages in `dependencies` are correctly placed despite being compiled into `dist/`:
  this package is also a source-first library consumed by siblings, so they must be real
  dependencies. `electron-builder.yml:44-51` then excludes them from the bundle by name. That is the
  design, not a misclassification.

---

## Exports with no references — keep, revisit later

Verified with `/usr/bin/grep` across source and tests:

| symbol | file:line | note |
| --- | --- | --- |
| `replayFileSql` | `src/model/quack.ts:57` | `source.ts:154-157` reimplements it inline, same regex |
| `localShardBytes` | `cc-assay/src/export.ts:210` | `export-cli.ts:95` inlines `statSync(file).size` |
| `fetchWithProgress` | `src/duckdb.ts:22` | re-export with no consumer |
| `paletteSize` | `src/model/palette.ts:80` | |
| `recordType`, `isUser`, `containingSession`, `NAME_RECORD_TYPES` | `cc-assay/src/fields.ts:53,55,172,225` | |

The four `fields.ts` accessors are a judgement call rather than plain dead code — that file is
documented as "the point of the package", a deliberate schema-knowledge API. `cc-assay` is
`private: true` and never published, so the API is aspirational, but removing schema accessors is a
different decision from deleting incidental code.

**`selectShards`** (`cc-assay/src/export.ts:225`) is **test-only**, referenced solely by
`export.test.ts:8,68,83,96,113,117`. Its purpose — budgeted shard selection for local-bytes mode —
has no caller: `source.ts:103-120` loads every non-replay shard with no budget. Removing it means
also removing `export.test.ts:68-123` and the `bytes` field on `ShardEntry` (`export.ts:55`).

---

## Duplication — record, fix later

- **The grain list, four copies** — `cc-assay/src/parquet.ts:268`, `cc-assay/src/export.ts:33`,
  `server/duckdb-host.mjs:129`, `src/model/store.ts:77+93`. The `.mjs` copy **must** stay separate
  (asar pruning, same reason as `corpusDir`), but a cross-check test asserting the four agree would
  catch drift.
- **CLI arg parsing, three `arg()` copies with different semantics**, plus two for-loop styles
  (`export-cli.ts:29`, `mine-cli.ts:32`, `duckdb-host.mjs:109`; `cli.ts:48`, `raw-cli.ts:23`). They
  **disagree on strictness**: `cli.ts` exits 2 on an unknown flag, the others silently ignore — so
  `cc-assay mine --replays` (a typo for `--replay`) runs a full mine with no replay grain and no
  complaint. One `cc-assay/src/args.ts`. Note `raw-cli.ts` disappears with `CLEANUP-PLAN.md` §9.
- **The AWS SSO error-disambiguation block, verbatim twice** — `export-cli.ts:159-177` and
  `duckdb-host.mjs:314-330`.
- **`prepare()` in `timeline-client.ts:148-160`** awaits `loadForkEdges`, `loadGhostSessions`,
  `loadNames` and `loadAllSpans` **in series** with no dependency between them — four sequential
  round-trips before first paint. Not a size problem, but it is on the critical path.
- **Transcript classification, three copies** — `scan.ts:77-82 kindOf`, `raw-source.ts:162-171`
  (whose own comment admits "Mirrors `scan.ts`"), `raw.ts:114 classify`. Two of the three disappear
  with `CLEANUP-PLAN.md` §9; unify what remains before an activity watcher becomes a fourth.

---

## Feature groundwork — information only, do not attempt yet

Where the three planned features land, and what will hurt.

### Config for data location

Painful in exactly one place: **`store.ts`**. `resolveSource(mode, …)` takes only a mode; a location
is a second axis, and `sourceMode` / `MODES` / `sourceLabel` / the `setSource` action are all written
around one enum.

Follow `source-mode.ts`'s own pattern — a pure `src/model/corpus-config.ts`, layer 1, storage
injected, exhaustively testable, resolving URL → storage → default exactly as `resolveMode` does,
plus one `durableSignal` (**not** a `control` — a path is not a slider). Small work **if `CLEANUP-PLAN.md`
§10 lands first**; otherwise every iteration forces a full app reload.

`corpusDir()` is duplicated deliberately (`host-runtime.mjs:48-60`) and must not be "fixed" into an
import. `corpus-dir.test.ts` and `server/corpus-route.test.ts` each pin one half — **nothing asserts
the two agree.** That is the gap worth closing.

### Run the miner from the UI

The blocker is not a large file. `run.ts:89 normalizeCorpus` is already the right shape — an exported
orchestrator with `onProgress`. **Stage 2 has no equivalent:** `export-cli.ts` is a 177-line script
with *zero exports*, and `mine-cli.ts` chains the stages with `spawnSync("npx", ["tsx", …])`, which
gives no structured progress and cannot work from a packaged app.

Needed: `cc-assay/src/export-run.ts` exporting `exportCorpus({ onProgress })` mirroring `run.ts`,
then `cc-assay/src/mine.ts` exporting `mineCorpus()` calling both in-process; `mine-cli.ts` shrinks
to argument parsing. `node.ts` must also gain `export * from "./export.ts"` — it does not export
stage 2 at all today.

Server side, `electron/duckdb-sidecar.mjs` is the exact template (idempotent `ensureHost`,
`utilityProcess.fork`, runtime-file advertisement), and `protocol.handle` supports POST — so **no IPC
is needed** and that invariant survives. A new route must land in *three* places:
`host-runtime.mjs:mountHostRoutes`, `app-scheme.mjs:serveApp`, and the renderer client.

**Two hard blockers independent of code shape:** `electron-builder.yml`'s allowlist excludes
`node_modules/@habemus-papadum/**`, and `tsx` is a devDependency — **the packaged app cannot run the
miner today at all.**

### Real-time activity detection

Belongs as a **cell in `graph.ts`**, not a signal in `store.ts` — precisely the case the `CLAUDE.md`
reload rule was written for. Touches `cc-assay/src/scan.ts` (`defaultRoots`, `kindOf`) and needs a
route in both server mounts.

Unify transcript classification first (see Duplication above), or the watcher becomes a fourth copy.
