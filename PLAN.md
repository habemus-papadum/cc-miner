# Cleanup plan — what we are actually doing

Decided 2026-07-31 from the four-way review in the previous session. Everything here is agreed and
scoped. Anything *considered* and shelved is in [`BACKLOG.md`](./BACKLOG.md); anything considered and
turned down is in [`DECLINED.md`](./DECLINED.md).

file:line references are from `d406ddf`. **None of this is applied yet.**

Two method notes that cost time last round:

- **This shell aliases `grep` to `ugrep`, which silently under-reports.** Use `/usr/bin/grep` for any
  reference count you are going to act on.
- Every step below should end green on `pnpm lint && pnpm typecheck && pnpm -r test`. The packaged
  smoke (`pnpm -C pdum-cc-miner pack:dir && pnpm -C pdum-cc-miner smoke`) is the gate for anything
  touching `electron/`, `server/`, or the DuckDB wiring.

---

## Order

Shipped bugs first (they are user-visible and independent), then the one-line trap fix, then
deletions, then the splits. Deletions before splits deliberately: removing the `raw` layer shrinks
`cc-assay` before `normalize.ts` gets restructured.

| # | item | scope |
| --- | --- | --- |
| 1 | Empty-state panel prints an unusable command | `src/ui/App.tsx` |
| 2 | Replay panel, same defect | `src/ui/SessionReplay.tsx` |
| 3 | "Release notes" button is dead in every shipped build | `electron/updater.mjs` |
| 4 | Delete `serve:s3` | `pdum-cc-miner/package.json` |
| 5 | One `format.ts` — six `usd` copies that disagree | `src/ui/*` |
| 6 | Declare `@types/node` in both subpackages | two manifests |
| 7 | Stale comments describing removed behaviour | 6 files |
| 8 | Delete `--flat` / `PDUM_CC_MINER_FLAT` | host + sidecar |
| 9 | Delete the `raw` ingest layer | `cc-assay`, 7 files |
| 10 | Split `store.ts` | `src/model/` |
| 11 | Split `normalize.ts` | `cc-assay/src/` |
| 12 | Split `graph.ts` | `src/model/` |
| 13 | Bundle cc-assay into the packaged app — **inclusion only** | build step |

§13 is groundwork rather than cleanup, and it must come **after §9** — there is no point bundling
the `raw` layer on Tuesday and deleting it on Wednesday.

---

## 1. Empty-state panel prints a command that cannot work

`pdum-cc-miner/src/ui/App.tsx:61` shows `pnpm -C pdum-cc-miner normalize`. Three faults: it writes
the **flat** layout the app cannot read; it writes to `--out ../pdum-cc-miner/src/data`, a deleted
directory nothing reads; and because production builds are host-only, **this panel is what a `.dmg`
user sees** — no checkout, no pnpm, no `cc-assay`.

Fixing the string is necessary but not sufficient. Lead with the **directory**
(`~/.cache/cc-miner`) — the one fact a packaged user can act on, since they can point
`PDUM_CC_MINER_CORPUS` at a corpus copied from elsewhere — then give `pnpm -C cc-assay mine` as the
developer path, and say in a comment that the real fix is running the miner from the UI.

## 2. Replay panel has the same defect

`pdum-cc-miner/src/ui/SessionReplay.tsx:241` prints
`pnpm -C cc-assay normalize --out ../pdum-cc-miner/src/data --replay`. Correct:
`pnpm -C cc-assay mine --replay`. Verified — `mine-cli.ts:56` forwards `--replay` to stage 1 and
`export-cli.ts:106-127` carries `replay/` and `replay/index.json` into the corpus.

**Also in scope, and flagging it because it sits inside a section that was otherwise deferred:**
`cc-assay/README.md:9,18-20` and `cc-assay/src/cli.ts:6` still document the flat-corpus quickstart
that `mine` was written to close, and **the cc-assay README never mentions `mine` at all**. That is
the same "we print a command that misleads" bug as §1 and §2. The `normalize` *script* stays (see
`BACKLOG.md`) — this is only the documentation that misdirects people to it. Say so if you'd rather
it waited.

## 3. "Release notes" is dead in every shipped build

`electron/updater.mjs:30` — `FEED_REPO` comes only from `PDUM_CC_MINER_RELEASE_REPO`, which nothing
sets: not `release.yml`, not `pack.mjs`. The guard at `:84` is therefore never true. The repo is
already compiled into the bundle from `electron-builder.yml`'s `publish:` block; fall back to it.

## 4. Delete `serve:s3`

`pdum-cc-miner/package.json:34` ends in a bare `--s3-prefix` with no value, and `arg()`
(`server/duckdb-host.mjs:109-112`) returns `undefined` for a trailing flag — so it **silently serves
the local corpus**. Delete the script.

Consider also making a valueless `--s3-prefix` exit non-zero in `duckdb-host.mjs`, so the footgun
cannot come back through a hand-typed command. Asking for S3 and quietly getting local is the same
class of lie as a data mode falling back, which this codebase refuses everywhere else.

## 5. One `format.ts`

Six copies of `usd` and they **disagree**: `ProjectFilter.tsx:26` uses `toFixed(0)`/`toFixed(2)`,
`Summary.tsx:24` adds a `>= 100` tier, and `SessionTimeline.tsx:79`, `Sessions.tsx:20`,
`SessionDetail.tsx:34`, `Attribution.tsx:14` are identical to each other. Also `when` twice, and
**`dur` in three mutually incompatible forms** — milliseconds in two files, seconds in
`Sessions.tsx:21`.

New `src/ui/format.ts`. This is a real cosmetic bug, not merely duplication: pick the intended
behaviour per formatter rather than blindly taking the majority.

## 6. Declare `@types/node` in both subpackages

It is declared **only** at the root but required by `cc-assay/tsconfig.json:5` and
`pdum-cc-miner/tsconfig.node.json:18` via `types: ["node"]`. Both packages typecheck purely because
TypeScript walks up to root `node_modules`; removing the root entry fails immediately with
`TS2688: Cannot find type definition file for 'node'`.

The root prune itself is deferred (`BACKLOG.md`), but do this now — it removes a trap that will
otherwise fire the moment anyone touches the root manifest.

## 7. Stale comments describing behaviour that no longer exists

- The **`/quack` proxy was removed** (`server/host-runtime.mjs:10-31` explains why at length), but
  three places still promise it: `server/vite-plugin.ts:5`, `vite.config.base.ts:49`,
  `pdum-cc-miner/README.md:33`.
- `vite.electron.config.ts:4-5` — "There is no packaging story yet." Four releases stale.
- `electron/smoke.mjs:24` — "`src/data` is already a Hive corpus." It is gone, and it was flat.
- `server/host-runtime.mjs:187` and `pdum-cc-miner/README.md:249` advertise `pnpm serve --flat` as
  "the legacy flat src/data layout" — both the flag (§8) and the directory are going.

## 8. Delete `--flat` and `PDUM_CC_MINER_FLAT`

`server/duckdb-host.mjs:148,158,196,218` (`FLAT_GLOB`, the `flat` argument, both glob branches) and
`electron/duckdb-sidecar.mjs:70,73`.

Nothing writes a flat corpus to a path the app reads by default. `mine` puts the flat intermediate
in `<corpus>/.staging`, which `corpusFile()` (`host-runtime.mjs:87-89`) explicitly refuses to serve.
Also update the no-host error at `host-runtime.mjs:187`, which names the flag — `host-runtime.test.ts:73`
only asserts `/pnpm serve/`, so no test change is needed.

## 9. Delete the `raw` ingest layer

`cc-assay/src/raw-cli.ts`, `raw.ts`, `raw-source.ts`, `raw-parquet.ts`, `raw-run.ts`, plus
`raw.test.ts` and `raw-equivalence.test.ts`. Then: the `raw` script in `cc-assay/package.json:27`,
`--raw` in `cli.ts:51,62,65,71-74`, and `RunOptions.rawDir` in `run.ts:26,90,130-133`.

It is a second, untravelled ingest route: reachable only via its own CLI, and **`mine` never touches
it** (`mine-cli.ts:68-83` runs `cli.ts` then `export-cli.ts` only).

Two things to check on the way out: `hyparquet` is a `cc-assay` dependency used at
`raw-source.ts:17` — confirm with `/usr/bin/grep` whether anything else needs it before removing it
from the manifest. And `raw-equivalence.test.ts` is the only thing asserting the two ingest routes
agree; deleting the route deletes the reason that test exists, which is correct, but note it in the
commit so it does not read as lost coverage.

## 10. Split `store.ts` (746 lines, six responsibilities)

Do this **before** the config feature. `CLAUDE.md` calls this file "guarded, rarely-edited wiring…
editing it forces a full reload" — already false, since two of its six concerns are ordinary widget
state that developers will touch constantly.

- **new `src/model/scope.ts`** (~30) — `appScope`, `scopedState`. **Load-bearing, do this first:**
  without it `crossfilter.ts` needs `appScope` from `store.ts` while `store.ts` needs `filter` from
  `crossfilter.ts` — a cycle.
- **new `src/model/crossfilter.ts`** (~200) — `filter`, `viewFilter`, `filterVersion`, `filterSql`,
  `filterActive`, `brushRange`/`brushTime`, `visibleProjects` and friends.
- **new `src/model/view-state.ts`** (~90) — collapsed projects, expanded sessions, focus. No engine
  dependence; currently trapped behind the reload wall for no reason.
- **new `src/model/corpus.ts`** (~90) — `TABLES`, `OPTIONAL_TABLES`, `Manifest`, `CorpusSummary`,
  `LoadProgress`, plus a shared `summarySql(where)`.
- `store.ts` keeps boot/engine, source mode, replay, and the `store` façade (~330).

**Consumer churn should be zero** — keep the `store` object literal re-exporting, and the nine
importers stay untouched. Do **not** move `filterSql()` into a pure module: it reads live Mosaic
`Selection` state and is layer 2 by nature. Also update `CLAUDE.md`, whose description of this file
will no longer be true.

## 11. Split `normalize.ts` (1626 lines; the `Normalizer` class alone is 992)

Mechanical, zero behaviour change:

- **new `cc-assay/src/grains.ts`** (~390) — the ten row interfaces (`TurnRow` … `NormalizeStats`).
  Type-only. The win: `parquet.ts` stops importing a 1000-line class module for nine type names.
- **new `cc-assay/src/invariants.ts`** (~105) — `checkInvariants` + `InvariantResult`, already
  independent of the class.
- `normalize.ts` drops to ~700.

Add both to `cc-assay/src/index.ts` so the published surface is byte-identical.

Optional and worth it if the first step goes smoothly: `agentRunRows`, `sessionRows`, `forkEdgeRows`,
`lineageRows`, `billedAnchor` are already near-pure → `rollups.ts`, taking `normalize.ts` to ~400.

Functions to extract regardless of the file split: `add()` (120 lines, five-way dispatch),
`turnRow()` (107 — the token/cost loop is a pure function of `(units, fellBack, pricing)`, and it is
what a pricing change touches), `sessionRows()` (124, three nested loops).

When this lands, the fork-lineage block in `normalize.test.ts:542-940` moves with it.

## 12. Split `graph.ts` (653 lines)

**new `src/model/actions.ts`** (~170) — `kit`, `registerStandardTools(kit)`, `querySql`, `brush`,
`inspectSession`, `setSource`, `foldProjects`. `graph.ts` keeps the 13 cells.

Cheap, and both planned features add *a cell and an action*; separated, each list stays readable.

Kill while in there: the "focused session, else the priciest" block is byte-identical at `:365-371`
and `:432-439`; `attribution` (`:192-211`) and `attributionTotals` (`:147-159`) are the same
three-arm `UNION ALL` with and without the filter; `liveSummary`'s inline type (`:279-289`) restates
`CorpusSummary` field for field and its SQL restates `querySummary`.

## 13. Bundle cc-assay into the packaged app — inclusion only

**Scope, deliberately narrow: the miner's code ships inside the app and can be loaded by Node.**
Not in scope — running it from the UI, progress reporting, the process model, or the fact that a
naive call would block. Those are design questions for later and are sketched in `BACKLOG.md`.

### Why the code is absent today

Three independent blockers, and fixing any one alone changes nothing:

1. **The allowlist excludes it.** `electron-builder.yml` has `!node_modules/@habemus-papadum/**`,
   written when every package under that scope was renderer-side and already compiled into `dist/`.
   `@habemus-papadum/cc-assay` is caught by a rule that predates it having any reason to ship.
2. **cc-assay is TypeScript with no build.** Its `main` is `./src/index.ts`; Node cannot run it.
3. **The TypeScript runtime is not shipped either.** `tsx` is a `devDependency` and electron-builder
   bundles only production `dependencies`. `bin/cc-assay.mjs` also shells out to `npx tsx`, which
   assumes a registry and a `node_modules` that will not exist.

Already in our favour: `@duckdb/node-api` is **already** a production dependency of the app, already
bundled and already `asarUnpack`ed for its native `.node`/`.dylib`. The other two cc-assay
dependencies — `hyparquet`, `hyparquet-writer` — are pure JS.

### The approach

Precompile cc-assay's node half into a single ESM file **inside the app's own tree**, at
`pdum-cc-miner/server/miner.mjs`. That one move clears all three blockers: `server/**` is *already*
in the `files` allowlist so nothing about packaging config changes; there is no `.ts` at runtime; and
`tsx` is not needed.

- **Bundler:** esbuild. Add it as an **explicit devDependency of `pdum-cc-miner`** — it is present
  today only transitively via Vite, and depending on a transitive package for a build step is the
  kind of thing that breaks silently on an unrelated upgrade.
- **Entry:** a dedicated `cc-assay` entry that pulls in **both** stages. Note `cc-assay/src/node.ts`
  does **not** export stage 2 today, so bundling it as-is would silently produce a miner that can
  normalize and not export — precisely the half-working artifact this repo keeps designing against.
- **External:** `@duckdb/node-api` only. It has native bindings; bundling it would break `.node`
  resolution. Left external, it resolves from the already-unpacked tree at runtime.
- **Inlined:** `hyparquet`, `hyparquet-writer`, and cc-assay's own modules.
- **Where it runs in the build:** in `electron/pack.mjs`, alongside the `vite build` step and for the
  same stated reason — packaging a stale one produces an artifact that looks fine and is not.

### Acceptance — this is the whole test

1. `npx asar list <app>/Contents/Resources/app.asar | /usr/bin/grep miner.mjs` finds it.
2. The bundle **loads under plain Node with no `tsx`** — e.g. importing it, or a trivial
   `--help`-style entry. This is the claim that matters: inclusion without loadability is worthless.
3. `pnpm smoke` still passes, and `app.asar` stays under the 140 MB budget in `pack.mjs`. It is
   ~89.6 MB today and this adds little, but the budget assertion is the tripwire and should be seen
   to hold rather than assumed.

### Notes for whoever does it

- Do **not** let this become a reason to "fix" the deliberate duplication of `corpusDir()`.
  `server/host-runtime.mjs:48-60` explains why it must not import across; a bundled miner sitting
  next to it does not change that argument.
- Once `hyparquet` and `hyparquet-writer` are inlined they no longer need to be resolvable at
  runtime — but leave `cc-assay`'s own manifest alone. It is still consumed source-first by the
  workspace, and that is deliberate.
- This does **not** make the app able to mine. It makes the code present and loadable, which is the
  precondition for everything in `BACKLOG.md` → "Run the miner from the UI".
