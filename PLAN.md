# Plan — navigation, jobs, and the always-on host

The staged execution order for [`ARCHITECTURE.md`](./ARCHITECTURE.md). Decided 2026-07-31.
`D1`–`D9` below are that document's decisions.

The completed cleanup pass is [`CLEANUP-PLAN.md`](./CLEANUP-PLAN.md). Considered-and-shelved is
[`BACKLOG.md`](./BACKLOG.md); considered-and-turned-down is [`DECLINED.md`](./DECLINED.md).
file:line references are from `148f9c5`. **None of this is applied yet.**

Method notes that cost time last round, and still apply:

- **This shell aliases `grep` to `ugrep`, which silently under-reports.** Use `/usr/bin/grep` for
  any reference count you are going to act on.
- Every step ends green on `pnpm lint && pnpm typecheck && pnpm -r test`.
- The packaged smoke (`pnpm -C pdum-cc-miner pack:dir && pnpm -C pdum-cc-miner smoke`) is the gate
  for anything touching `electron/`, `server/`, or the DuckDB wiring — **and it needs a corpus**, so
  it is manual, not CI.

---

## Order, and why this order

| stage | what | unblocked by | ships |
| --- | --- | --- | --- |
| **A** | Navigation + a second screen | — | back/forward that works in both shells; a Diagnostics screen |
| **B** | Fold `cc-assay` in | — (independent of A) | one package; the miner's code inside the `.dmg` |
| **C** | Job runner in the host | B | `mine` from the UI |
| **D** | Event stream + activity watch | C | live job progress; "new activity" notice |
| **E** | Config: where the data lives | A, C | a real Settings screen |
| **F** | Retire local mode | C, E | one data path |

**A before everything** because it is self-contained, touches no backend, and every later stage
needs somewhere to put a screen. Its second screen is **Diagnostics** rather than Settings on
purpose: Settings needs a host that can be reconfigured (Stage E), while Diagnostics needs nothing
that does not already exist, is immediately useful given how host-mode failures have presented here,
and — because boot is view-driven (`graph().dataset` is a cell) — **is reachable when the dashboard
is broken.** That property is what makes it worth building first, and §A4 protects it.

**B before C** is the one hard dependency, and it is D8: the packaged app cannot run the miner today
for two reasons that are both packaging, not plumbing — the `electron-builder.yml` allowlist
excludes `node_modules/@habemus-papadum/**`, and `cc-assay` is TypeScript run through `tsx`, which
is a devDependency the bundle does not have. Building the job runner first would mean writing it
against a module layout about to change.

**A and B are independent** and can be done in either order, or in parallel.

**E and F are not committed to.** They are planned to the same level as the rest so the shape is
visible, but the decision to start them comes after D lands.

---

# Stage A — navigation

No backend change. One new dependency: none.

## A1. The router

New `pdum-cc-miner/src/model/route.ts` — layer 1, pure, exhaustively testable in the manner of
`source-mode.ts`.

```
parseRoute(pathname): Route          // total; unknown → NotFound, never throws
routePath(route): string             // the inverse
```

`Route` is a discriminated union, starting at `{kind: "dashboard"} | {kind: "diagnostics"} | {kind: "notFound"}`.

Then a thin reactive layer — a `route` signal seeded from `location.pathname`, subscribed to
`popstate`, plus `navigate(route)` doing `pushState`. Roughly thirty lines (D4).

Two things to get right:

- **Not a durable root.** The URL is the storage. A durable copy is a second source of truth that
  survives a reload the URL already survived, and they can disagree.
- **`scopedState`/`appScope` are not involved.** This is not app state; it is where the window is
  pointed.

Tests: `parseRoute`/`routePath` round-trip for every variant, unknown paths, trailing slashes, and
paths carrying a query string (`?source=host` must survive navigation — see A5).

## A2. The shell and the screens

`src/ui/App.tsx` splits:

| file | what |
| --- | --- |
| `ui/App.tsx` | the shell: header, `SourceSwitch`, the breadcrumb, and a `<Switch>` over `route()` |
| `ui/Dashboard.tsx` | everything inside today's `CellView` — moved verbatim, no edits |
| `ui/Diagnostics.tsx` | new |

`Dashboard.tsx` must be a **pure move**. Anything that looks like an improvement while moving it
belongs in a separate commit; the whole value of this step is that its diff is mechanical.

The breadcrumb is a component (D5): `‹ Dashboard` when not on the dashboard, absent when on it.
`history.back()` when there is history to go back to, `navigate(dashboard)` otherwise — a
deep-linked tab has no back entry, and a dead-looking control is worse than one that navigates.

Lazy-load screens other than the dashboard with `import()` + `<Suspense>`. Cheap now, and it is what
keeps "many screens" a bytes question rather than a runtime one (D1).

## A3. Diagnostics

Read-only, and everything it shows is already available:

- host lookup: the raw `GET /__duckdb-host` answer — `ok`, `quackUri`, `grains`, `missing`, `source`
- corpus: the resolved directory, and `manifest.json`'s `generatedAt` / `pricing` / `invariants`
- app: version, shell (`HOST` from `src/host.ts`), data mode, `MODES` this build has

Fetch the lookup **on mount, every time** — `hostInfo()` is deliberately read per request so a host
restart is picked up with nothing to invalidate (`host-runtime.mjs:141-148`), and a screen that
cached it would throw that away.

Explicitly **do not** call `store.ensureLoaded()` here. That is the point of the screen.

## A4. The `app://` fallback

`electron/app-scheme.mjs:182` currently 404s unknown paths, with a comment defending that. Preserve
the reason, narrow the rule (D3):

> Fall back to `index.html` only for `GET` requests whose `Accept` header includes `text/html`.
> Everything else keeps its 404.

Replace the existing comment rather than deleting it — it explains why an unconditional fallback is
wrong, which is still true and is what stops the next person widening this.

Vite handles dev and preview already; verify rather than assume (`curl -i http://localhost:5173/diagnostics`).

## A5. Gates

- `pnpm typecheck && pnpm test && pnpm lint`
- **Browser:** navigate to Diagnostics, browser-back, forward. Reload on `/diagnostics`. Confirm
  `?source=host` survives navigation, and that switching source from a non-dashboard screen returns
  somewhere sensible.
- **Packaged, and this is the one that cannot be checked any other way:** extend `electron/smoke.mjs`
  to navigate to `/diagnostics`, **reload**, and assert the screen renders. Without the reload the
  test passes with no fallback at all.
- Confirm the dashboard's state survives a round trip: brush a range, go to Diagnostics, come back,
  assert the brush is still applied and **no re-query happened**. That is D1's claim; measure it
  rather than assert it.

---

# Stage B — one package

Mechanical, and large in file count. Independent of A.

## B1. Move the source

`cc-assay/src/**` → `pdum-cc-miner/src/assay/**`, keeping `index.ts`'s barrel shape. Consumers
inside the moved tree change import paths; nothing outside imports `@habemus-papadum/cc-assay`
today (verified during the cleanup review), so the blast radius is the tree itself plus the two
manifests.

Delete `cc-assay/` and its workspace entry. Remove the `@habemus-papadum/cc-assay` dependency and
the `normalize` script from `pdum-cc-miner/package.json`.

Test files move with their sources. `pnpm -r test` becomes one suite; check the vitest config picks
up the new directory. `cc-assay/README.md` and `LAYOUT.md` move too — `source.ts:78` points at the
latter.

**The user-visible strings change with it.** Four places print `pnpm -C cc-assay …`, and all four
were just corrected in the cleanup pass for printing commands that could not work — do not let this
move reintroduce that: `src/ui/App.tsx:72`, `src/ui/SessionReplay.tsx:240`, `src/model/source.ts:96`,
and `cc-assay/README.md`. Nothing *imports* `@habemus-papadum/cc-assay` (verified: every remaining
mention in `src/`, `server/` and `electron/` is a comment or a printed string), so the code blast
radius really is the moved tree plus the two manifests.

## B2. Make it runnable inside the bundle

The CLIs run under `tsx`, which the packaged app does not have (D8). Precompile at pack time:
`electron/pack.mjs` gains a step that emits the assay CLIs to plain `.mjs` under a directory the
`files` allowlist already covers.

- Precompile only — **no optimisation, no bundling decisions**. The goal is the code being present
  and runnable, nothing more.
- Assert the output exists before packaging, the way `pack.mjs` already asserts the asar size. A
  missing CLI must fail the pack, not the app.

**Do not** collapse `server/host-runtime.mjs`'s duplicated `corpusDir()` into an import while doing
this. It is plain `.mjs` because the Electron main process executes it verbatim; the comment at
`:48-60` says so. What *is* worth adding here is the missing cross-check: `corpus-dir.test.ts` and
`server/corpus-route.test.ts` each pin one half and **nothing asserts the two agree**.

## B3. Gates

- `pnpm lint && pnpm typecheck && pnpm test`
- `pnpm mine` end to end, and diff the resulting manifest against one from before the move —
  invariants and totals identical
- `pack:dir` + `smoke`, both modes
- **Verify the CLI actually runs from inside the packaged app** — from `release/`, invoke the
  precompiled entry directly. This is the claim of the whole stage, and B2 can succeed at packaging
  while failing at `require`.

---

# Stage C — jobs in the host

## C1. Libraries under the CLIs

From `BACKLOG.md` → "Run the miner from the UI", verified: `run.ts:89 normalizeCorpus` is already
the right shape — an exported orchestrator with `onProgress`. **Stage 2 has no equivalent:**
`export-cli.ts` is a 177-line script with zero exports, and `mine-cli.ts` chains the stages with
`spawnSync("npx", ["tsx", …])`.

- new `export-run.ts` exporting `exportCorpus({ onProgress })`, mirroring `run.ts`
- new `mine.ts` exporting `mineCorpus()`, calling both in-process
- `mine-cli.ts` shrinks to argument parsing
- `node.ts` gains `export * from "./export.ts"` — it does not export stage 2 at all today

The CLI remains the single implementation (D6): the job runner spawns it rather than importing these.
They exist so the CLI is thin and so progress is structured.

## C2. The runner

In `server/duckdb-host.mjs`, not the Electron shell (D6, I2).

```
POST /__jobs         {kind, args} → {id}
GET  /__jobs         → running + recent
GET  /__jobs/:id     → status, exit code, last N lines of output
```

`electron/duckdb-sidecar.mjs` is the template: idempotent, fork, advertise. One job of a kind at a
time — a second `mine` against the same corpus is a corruption bug, not a queueing problem, so
refuse it explicitly rather than serialising silently.

State in memory **plus a small file**, so a renderer reload re-attaches to a running job instead of
orphaning it.

**Three mounts, as always** (`host-runtime.mjs:4-8`): `mountHostRoutes`, `app-scheme.mjs:serveApp`,
and the renderer client. `protocol.handle` supports POST, so no IPC (I3).

## C3. The Import screen

A route (D2). Start a mine, watch it, see the result. Until Stage D it polls `GET /__jobs/:id`;
polling is the honest v1 and D replaces it with a stream.

When it succeeds it must **reload** rather than mutate state in place — `setSourceMode`'s reasoning
applies verbatim (`store.ts:161`): the registered files and every cached table belong to the corpus
that just changed underneath them.

`ui/App.tsx:53`'s `NoData` panel gets a button to this screen. That comment names running the miner
from the app as the real fix; this is where it is delivered, and the comment should be updated
rather than left claiming a gap that closed.

## C4. Gates

- `pnpm typecheck && pnpm test && pnpm lint`
- Dev: `pnpm serve` + `pnpm dev`, run a mine from the UI, corpus updates, dashboard reflects it
- **Packaged:** `pack:dir`, run a mine from inside the app, with **no checkout on `PATH`**. This is
  what B and C exist for and the only run that proves it.
- Kill the host mid-job; confirm the UI reports a failed job rather than a spinner
- Reload the renderer mid-job; confirm it re-attaches

---

# Stage D — the event stream

## D1. Transport

`hostInfo()` (`server/host-runtime.mjs:181`) gains `eventsUri`, beside `quackUri`, built the same
way — from what was actually bound. The page uses it verbatim (I1). SSE, not WebSocket (D7). Token
in the query string, because `EventSource` cannot set headers.

Job progress moves from polling to the stream; C3's polling path is deleted, not kept as a fallback
(I4 — a fallback here would silently mask a broken stream).

## D2. Activity watching

`fs.watch` over `defaultRoots()`, debounced, in the host. **Unify transcript classification first** —
`BACKLOG.md` records the copies that survived the cleanup, and a watcher that classifies files is
about to become one more.

Per D7 and I4, the event is a **notice**, not a refresh: "N sessions since your snapshot", and the
user triggers a re-mine. Do not attempt incremental append; it is listed as open in
`ARCHITECTURE.md` §5 for a reason.

Belongs as a **cell in `graph.ts`**, not a signal in `store.ts` — it is disposable logic, and this is
precisely the case the `CLAUDE.md` reload rule was written for.

## D3. The visibility rule

This is the stage where `ARCHITECTURE.md` §4's rule becomes load-bearing. Before wiring any push to
the crossfilter, give Mosaic clients a way to say they are not visible. Cheapest correct version:
disconnect on unmount and reconnect on mount, since the coordinator is a durable root and survives
the component either way.

## D4. Gates

- Job progress arrives without polling; the network tab shows one open stream, not a request per
  second
- Kill the host: the stream reconnects when it returns, and the UI says so in between
- Touch a transcript; the notice appears; **assert the dashboard's numbers did not change**, because
  that is the invariant (I4)
- Navigate away from the dashboard during activity; confirm the timeline client is not querying

---

# Stage E — where the data lives

Not started until D lands. Shape, from `BACKLOG.md` → "Config for data location":

Painful in exactly one place, **`store.ts`**: `resolveSource(mode, …)` takes only a mode, and a
location is a second axis — `sourceMode` / `MODES` / `sourceLabel` / the `setSource` action are all
written around one enum.

Follow `source-mode.ts`'s pattern: a pure `src/model/corpus-config.ts`, layer 1, storage injected,
resolving URL → storage → default exactly as `resolveMode` does, plus one `durableSignal` — **not a
`control`**; a path is not a slider.

The host also has to *accept* a new location, which is what makes this depend on C: changing it
means restarting the host with new arguments, and the job runner is where host supervision lives.

The Settings screen is then a route with two fields and a restart.

---

# Stage F — retire local mode

Not started until E lands, and reversible up to that point (D9).

Expect **no size win** — duckdb-wasm stays, because it is in the page to speak Quack's wire format,
not to hold data. What goes: `source.ts`'s byte-fetching path, `/__corpus` in all three mounts,
`selectShards` and its tests, the `bytes` field on `ShardEntry`, and the two-mode branch in boot.

One commit, not a slow rot. `CLAUDE.md`'s "Two hosts, one renderer" section and the four numbered
designs both need rewriting in the same commit — design #1 (*no fallback between data modes*) stops
being about modes and becomes about locations.

---

## What this plan does not do

- **Session permalinks** — `ARCHITECTURE.md` D2. Blocked on what a URL-owned `focusedSession` means
  under a filter.
- **Incremental corpus refresh** — `ARCHITECTURE.md` §5.
- **Multiple windows** — D1 says pay for it when two views must be visible at once.
- **The dependency prune** — still `BACKLOG.md`, and Stage B changes its inputs, so it should not be
  attempted first.
