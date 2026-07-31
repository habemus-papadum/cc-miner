# Considered and turned down

Things the review proposed that we are **not** doing — including one that measured well and is still
being declined. Recorded so they are not re-proposed, and so the reasoning survives.

Agreed work is in [`PLAN.md`](./PLAN.md); deferred-but-alive items are in
[`BACKLOG.md`](./BACKLOG.md). file:line references are from `d406ddf`.

---

## Aliasing the `mvp` duckdb-wasm bundle — ~42 MB, declined

**The largest single size win found, and we are not taking it.**

`src/duckdb.ts:18,20,26` ships the `mvp` duckdb-wasm bundle: `duckdb-mvp.wasm` **41.3 MB** plus a
0.8 MB worker. Read from the installed `selectBundle`, `mvp` is reached only when
`wasmExceptions === false` — impossible in Electron 43 (Chromium ~140) and on every browser since
Chrome 95 / Safari 15 / Firefox 100. It is unreachable payload.

The key cannot simply be deleted: `DuckDBBundles` requires it and `selectBundle` dereferences it
unconditionally on the fallback branch. The safe edit is to alias it —
`mvp: { mainModule: ehWasm, mainWorker: ehWorker }` — and drop the two `mvp` `?url` imports.

Measured when applied: `dist/` 76 MB → **36 MB**, `app.asar` 89.6 MB → **46.9 MB**.

**Why declined anyway.** With it applied, `pnpm smoke` failed twice on the **second** navigation
(`?source=local`, which must fall through to host): once stuck loading at "summarizing", once with
`Failed to send message` against the quack endpoint. The first navigation passed both times. A
bisect against a reverted `duckdb.ts` was started and **never finished**, so it remains unknown
whether that is a regression from the aliasing or the same second-navigation flakiness seen
elsewhere in this app.

The size is not worth carrying an unexplained failure into a period of heavy change. If it is
revisited: **finish the bisect first**, and treat a green re-run as insufficient — the failure was
already intermittent, so passing once proves nothing.

---

## Splitting `timeline.ts` — declined

`pdum-cc-miner/src/model/timeline.ts`, 888 lines, **34% comment**.

Cohesive: every export serves the geometry of one chart. The length is largely the design record —
`DEFAULTS.laneGapPx`'s ten-sequential-sessions measurement (`:419-436`), `drawnExtent`'s "84 minutes
at month zoom" (`:218-230`), `connectedGhosts`'s transitivity argument (`:466-486`), `packLanes`'s
two load-bearing properties (`:182-204`). Splitting the types into a `timeline-types.ts` buys
nothing: only `timeline-client.ts` imports types without functions, and it imports exactly two.

**What to do instead, if it is ever painful:** extract functions *inside* the file. `layoutTimeline`
is 305 lines with four levels of nesting, and `routeForkEdges` (`:764-796`) and `routeLaunchEdges`
(`:798-819`) are **already pure functions of computed state** — they lift out with no restructuring
and take it to ~250. The `LayoutBar` object literal also appears four times (`:585-607`, `:629-652`,
`:663-683`, `:715-735`) with sixteen identical fields; a `makeBar()` helper removes ~60 lines of
repetition without touching a comment.

---

## Splitting `fields.ts` — declined

`cc-assay/src/fields.ts`, 739 lines, **34% comment**.

A single cohesive concept — "everything we know about the transcript schema" — and the comments
record exactly the measurements worth keeping: `preferForBilling`'s 32% undercount and its
max-not-last argument, `isInherited`'s continuation case, `agentNameOf`'s 368-of-368 verification.
No function exceeds ~30 lines; no deep nesting.

One optional move if it is ever wanted: `DIMENSIONS` (`:553-614`) and `TRAPS` (`:628-739`) are 185
lines of documentation *data* with no callers in the pipeline. They are **not dead** — `node.ts`'s
docstring says the demo reuses them for UI copy — so a `catalog.ts` re-exported from the barrel
would take `fields.ts` to ~550 and leave it purely accessors. Low urgency, and not planned.

---

## Splitting `parquet.ts` — declined

`cc-assay/src/parquet.ts`, 423 lines, **12% comment** — the lowest ratio of the large files, and
still not a problem. Eight near-identical column lists, ~260 lines of pure declaration. `col()` is 14
lines; the writers are 18 and 42. This is schema **breadth**, not complexity, and splitting the
column lists would only add files.

(Its `TABLES` at `:268` is one of the four copies of the grain list — that is tracked in
`BACKLOG.md`, and is about duplication rather than file size.)

---

## Splitting `SessionTimeline.tsx` — not now

`pdum-cc-miner/src/ui/SessionTimeline.tsx`, 569 lines, one component function of 475.

There is a real split available — a `timeline-palette.ts` (the colour ramp plus its dataviz
validation notes), a `TimelineLegend.tsx`, and a `useTimelineBrush.ts` holding the pointer/brush
gestures, which are the only genuinely tricky logic in the file and are **untestable today** because
they are closed over the component.

Declined for now on priority: **none of the three planned features touches this file.** Revisit when
one does.

---

## Splitting `timeline-client.ts` and `lineage.ts` — declined

- `timeline-client.ts` (578 lines, 39% comment) — each load method is 25–45 lines and well shaped;
  `SelectionStatsClient` is only 35 lines and does not warrant its own file. Its one real issue is
  serial loading, tracked in `BACKLOG.md`, which is a latency question rather than a structural one.
- `lineage.ts` (373 lines, 42% comment) — under the threshold and highly cohesive. `resolveLineage`
  is 144 lines across five comment-delimited phases; if it is ever touched, `dropCycles` (`:276-288`)
  and `buildChains` (`:290-316`) are self-contained and lift out mechanically.

---

## Splitting the test files — declined

`normalize.test.ts` (1067 lines, 14 describes) and `timeline.test.ts` (728, 11 describes) are
one-describe-per-behaviour and are exactly the exhaustive layer-1 suites `CLAUDE.md` demands.

They should not be split **ahead of** their source. When `normalize.ts` splits (`PLAN.md` §11), the
fork-lineage block at `normalize.test.ts:542-940` moves with it — that is the correct trigger.

---

## Rejected on principle, whatever the file size

- **Any split that gives a pure module a framework or `node:fs` import.** No proposal above does, and
  none should. `parquet.ts:328` shows the correct pattern — inject `fs`/`join` rather than import
  them.
- **Moving `store.ts`'s `filterSql()` into a pure module.** It reads `filter.predicate(undefined)`
  off a live Mosaic `Selection`; it is layer 2 by nature and belongs with the crossfilter.
- **"Fixing" the deliberate duplication of `corpusDir()`** into a shared import
  (`host-runtime.mjs:48-60` explains why: the packaged bundle prunes `node_modules` to the
  electron-builder allowlist, so an import there fails at `require` time inside the `.dmg`). The
  right response is a test asserting the copies agree — tracked in `BACKLOG.md`.
