# pdum-cc-miner

The app half of this repo: **your own Claude Code usage** — cost per turn, where the money went,
and whether a session was time well spent. SolidJS + Mosaic + DuckDB, built on
`@habemus-papadum/aiui-viz`. Its data comes from [`cc-assay`](../cc-assay) next door.

Read [README.md](./README.md) for the build, the size budget, and the signing story;
[DEPLOYMENT.md](../DEPLOYMENT.md) for what is measured versus what has never run. This file is
what to know **before editing**.

## It ships with no data, and that is the first-run state

`src/data` is gitignored and always will be — a mined corpus carries conversation text, project
names, branch names and paths. A fresh clone renders `NoData` in `ui/App.tsx`, which is correct,
not broken. Make your own:

```sh
pnpm -C ../cc-assay normalize --out ../pdum-cc-miner/src/data
```

So: **never add a fixture corpus to the repo to make something demoable**, and never treat an
empty page as a bug to paper over. Tests use fabricated rows, not a corpus.

## Two hosts, one renderer — the invariant that costs the most to lose

cc-miner runs in a browser tab (`pnpm dev`, 5173) and in an Electron window (`pnpm dev:electron`,
5179, CDP on 9333 — *not* 9222, which belongs to the shared aiui session browser). Both are Vite
dev servers over the **same renderer**. Electron is not a different build; it is a different
window pointed at an equivalent server.

- **Never branch the renderer on a build flag to tell the hosts apart.** `src/host.ts` sniffs the
  user-agent at runtime. A `define` would make the two bundles genuinely different, and "it runs
  the same in a tab and a window" would stop being a claim anyone could check. It is for cosmetics
  and host-specific affordances that have a browser fallback — **not** a data-access switch.
- **Keep the two Vite configs' delta small enough to read.** `vite.config.ts` /
  `vite.electron.config.ts` differ by the dev port; everything else lives in
  `vite.config.base.ts`.

## Four designs arrived at by failing the other way

Each of these was reached by doing the opposite first. Carry them intact.

1. **No fallback between data modes.** `?source=local` / `?source=host`, remembered; asking for
   `host` with no host is an **error**, never a quiet downgrade. A stale local corpus standing in
   for the real one is invisible in the UI and expensive in trust. `model/source-mode.ts` resolves
   URL → storage → `local`, and availability is deliberately absent from that list.
2. **The origin tells the page where the data is; the page never derives it.** `quackUri` arrives
   from `GET /__duckdb-host`. It used to be built from `location.host` — right over http, and
   under the packaged app's `app://pdum-cc-miner/` it produced a hostname DuckDB dialled over TCP,
   failing by *hanging*, with no request and no error.
3. **No IPC to the Electron shell.** The sidecar starts lazily on the first `/__duckdb-host`
   request, which the renderer only makes in host mode — so the lifetime is already right and
   there is no signal to invent.
4. **The SQL travels, not the table.** `model/quack.ts` wraps Mosaic's `wasmConnector` and
   rewrites the SQL into `quack_query`. `ATTACH`-ing the remote catalog does **no pushdown**: a
   bare `count(*)` over a 272 MB table moved 5.26 GB, versus 5 ms and ~0 bytes. duckdb-wasm is
   kept in the page for exactly one job — speaking Quack's wire format.

**Don't remove the aiui integration.** `aiui()` in `vite.config.base.ts` stamps JSX with
`data-source-loc` and injects `cell()` identities (the latter in *every* mode — load-bearing for
durable cells). It must stay ordered **before** `solid()`, or the locator's `pre` pass runs after
JSX has been compiled into an opaque template. Never hand-write a `data-source-loc` — locations
are compiler output.

## The four layers, and where they are

Build thin vertical slices in this order
([playbook](https://habemus-papadum.github.io/pdum_aiui/guide/frontend-playbook)):

| layer | here | test with |
| --- | --- | --- |
| 1. pure model | `model/timeline.ts`, `session-detail.ts`, `replay.ts`, `rows.ts`, `source-mode.ts`, `durable-state.ts` | plain vitest, exhaustively |
| 2. state + cells | `model/store.ts` (durable roots, control surface), `model/graph.ts` (the dataflow) | `@habemus-papadum/aiui-viz/testing`, one `whenReady` probe per input |
| 3. components | `ui/*.tsx` — pure readers rendering cells through `CellView` | — |
| 4. application | `ui/App.tsx` — the reading order *is* the argument the page makes | — |

`model/timeline.ts` is the largest pure module and the most valuable: the session-graph layout
(lane packing, fork edges, ghost sessions). Keep it framework-free and time-free.

**store.ts versus graph.ts.** `store.ts` is guarded, rarely-edited wiring — editing it forces a
full reload, since it is everything's ancestor. `graph.ts` and `ui/` are *disposable logic*:
`hotCellGraph` rebuilds the graph over the durable roots on every hot edit, and components read
`graph().someCell` through the stable accessor so they can never hold a stale cell reference.

**Thread the scope.** `appScope = scope("pdum-cc-miner")` qualifies every declaration —
`control({ scope: appScope, … })`, `appScope.durable(…)`/`durableSignal(…)`,
`cell(deps, compute, { scope: appScope })`, `action({ scope: appScope, … })`. It is what lets this
app share a document with other aiui apps without colliding on the window-global registries.
Never declare an unscoped control/cell/action.

**Declaring IS exposing.** The control surface is curated, not automatic: user-movable parameters
are `control({ … })` with a real doc comment (the compiler injects the name from the binding and
lifts the comment as the agent-facing description — no name, no hand-written description).
Everything else — engines, connections, transient bookkeeping — uses `durableSignal()`/`durable()`.
Today the surface is one control, `idleGapMinutes` (where "thinking" ends and "went to lunch"
begins — a control because duty cycle moves a great deal with it), plus four actions in
`graph.ts`: `query`, `brush`, `inspect`, `fold-projects`. Add verbs as `action({ name, run })` next
to the feature; do **not** hand-write get/set-params tools, and reserve `kit.registerTool` for the
genuinely bespoke case.

One panel is not a pure reader, deliberately: `ui/SessionTimeline.tsx` is a Mosaic client on the
shared crossfilter, so brushing a time range re-queries every other client through the coordinator
rather than through the component tree.

## Packaging is wrapped for a reason

Always `pnpm pack:mac` / `pack:linux` / `pack:dir`, never `electron-builder` bare. Two fields in
`package.json` are right for a workspace member and wrong for a desktop app, and neither may be
edited in the tree — `electron/pack.mjs` rewrites both via `extraMetadata`:

- **`main`** is `./src/index.ts`, the library barrel siblings import source-first; the bundle needs
  `electron/main.mjs`.
- **`version`** is the lockstep marker, and a semver trap: comparison **ignores build metadata**,
  so `0.12.0+dev` and `0.12.0` compare *equal* and an updater would never fire. Local builds get
  `0.12.0-dev.<sha>`, a prerelease that sorts strictly below the release.

`pack.mjs` also refuses to sign with an `Apple Development` certificate, and asserts the
`app.asar` size because `files` in `electron-builder.yml` is a name-based allowlist that can rot.
Before touching `build/entitlements.mac.plist`, read it — each of its four holes is justified, and
`disable-library-validation` is **measured** load-bearing for host mode.

## The gates

```sh
pnpm typecheck      # tsc over both tsconfigs — src and the node-side scripts
pnpm test           # vitest
pnpm lint           # biome, from the repo root
```

`electron/smoke.mjs` drives the *packaged* app over CDP in both data modes and is the check that
"it builds" is not mistaken for "it boots" — but it needs a corpus, so it is a **manual** gate
here (`pnpm pack:dir && pnpm smoke`), not a CI one.

## A test that stops testing is worse than one that never existed

Found while tightening this app's ghost-node rules, and the reason
[`model/timeline.test.ts`](./src/model/timeline.test.ts) opens with a note about it: changing what
the layout renders broke two tests, one loudly and one **not at all** — the second had silently
become `expect(undefined).not.toBe(0)`, a check that can never fail, on a fixture no longer
containing what it was written to inspect. The `?.` added to satisfy Biome's `noNonNullAssertion`
is what did the damage.

So: **assert existence before asserting about a property** (`expect(bar).toBeDefined()` on its own
line), and prefer `?.` in an assertion only when the absence is itself part of the claim — where a
value must exist for the test to mean anything, a `!` that throws is *more* honest than a chain
that yields `undefined`. After changing what a function emits, grep the tests for the removed
thing rather than trusting a green run; negative assertions (`not.toBe`, `toHaveLength(0)`) turn
vacuously true.

The full write-up lives at `src/model/timeline.test.ts:569`, next to the code it governs.
