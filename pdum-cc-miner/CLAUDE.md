# demo: ledger

An in-repo demo app, scaffolded by `pnpm new-demo` from the same starter template
`create-aiui` ships. Its visible content — the banner, the rose — is **placeholder scenery meant
to be replaced** by whatever this demo is for. Be bold about rebuilding the page; be careful about
the wiring underneath.

It differs from a scaffolded sandbox in exactly two ways, both deliberate:

- `@habemus-papadum/*` deps resolve through `workspace:^` — you are editing the real packages
  next door, live, with no build step. A change to `packages/aiui-viz` shows up here on save.
- It lives in this repo's git history. Commits here are commits to pdum_aiui.

Run the dev server with `pnpm dev` from this directory (plain `vite`); the intent client
reaches the channel through the channel-served `/intent/` page or the side panel, so the dev
server needs no channel wiring of its own.

**This app has a second host.** `pnpm dev:electron` runs the same app in an Electron window
(port 5179, CDP on 9333) instead of a browser tab (port 5173). Both are dev servers over the
same renderer; the split lives in `vite.config.ts` / `vite.electron.config.ts` with the shared
part in `vite.config.base.ts`, and the shell code is in `electron/`. Two rules while editing:
keep the two configs' delta small enough to read, and never branch the renderer on a build flag
to tell the hosts apart — `src/host.ts` answers that at runtime, which is what keeps the bundles
identical. See README.md.

The app has a **dual shape** — it is both a standalone app and a library:

- `src/main.tsx` mounts `src/page.tsx`, the app as a mountable `SitePage`
  (from `@habemus-papadum/aiui-viz`): one page contract for both hosts — this dev server, or a
  multi-app shell that discovers the page through the `aiui.sitePage` marker in `package.json`
  and the `./page` export.
- `src/index.ts` is the library barrel (the `.` export): the scope, the graph, the root
  component, and — as the real app grows — its widgets and pure model. Keep all three export maps
  in `package.json` pointing at source; keep page wiring (styles, graph side effects) out of the
  barrel.
- `src/card.tsx` is the app's **landing card** (aiui-viz's `DemoCard`, the `./card` export): a
  blurb + a LIVE preview mini-app a gallery shows before you open the app. The preview must be
  self-contained and cheap — build it from your *pure* model only, never `store`/`graph` (a
  landing mounts every app's preview at once). The starter previews the rose (`ui/RosePreview.tsx`,
  scenery); after a reset it falls back to a name placeholder.

## Reset to a blank canvas

Every piece of placeholder scenery is fenced with markers, so resetting the app is a **mechanical
deletion — no code reasoning required**. If the user asks for a blank app (or you want a clean
canvas before building theirs), do exactly this and nothing more:

1. **Under `src/`, delete every file whose first line contains `<aiui-scenery-file>`.**
2. **In every remaining file under `src/`, delete each block** from a line containing
   `<aiui-scenery>` through the next line containing `</aiui-scenery>`, **inclusive of both
   marker lines**. (Only `src/` — docs like this one merely *mention* the markers.)
3. Verify: `pnpm typecheck && pnpm test` (both pass on the blank app; tests report
   "no tests" green).

The result compiles and runs: an empty page, an empty cell graph over empty durable roots, the
intent tool still mounted, the standard agent tools still registered. Do not "clean up" anything
else — unused-looking scaffolding outside the fences is the app's wiring.

(For authors editing the scenery instead of deleting it: keep the invariant that fenced code is
only ever referenced from other fenced code or fenced files, so step 1+2 can never break the
blank app.)

## The build order (the playbook)

When building the user's real app, work in the four-layer order of the
[frontend playbook](https://habemus-papadum.github.io/pdum_aiui/guide/frontend-playbook), thin
vertical slices first:

1. **Pure functions** (`src/model/*.ts`, like the rose's math) — domain logic, no framework, no
   time; unit-test exhaustively (see `rose.test.ts` for the shape).
2. **Cells** (`src/model/graph.ts`) — the computation boundaries: fetches, workers, streams,
   cancellation; test headless with `@habemus-papadum/aiui-viz/testing` (see `scenery.test.ts` —
   one `whenReady` probe per input per cell).
3. **Components** (`src/ui/`) — pure readers rendering cells through `CellView`.
4. **Application** (`src/ui/App.tsx`) — layout, sections, keyboard modes.

Ground rules:

- **Don't remove the integration.** The `aiui()` plugin in `vite.config.ts` stamps JSX with
  `data-source-loc` and injects `cell()` identities — the handles the intent client's
  screenshot/selection attribution reads. The loop stops working without it. (And never
  hand-write a `data-source-loc`/`data-cell-loc` — locations are compiler output.)
- **Keep the architecture's split.** `src/model/store.ts` holds the *durable roots* AND the
  **control surface**: user-movable parameters are `control({ scope: appScope, value, min, max, … })`
  with a real doc comment (the compiler injects the name from the binding and lifts the comment
  as the description — no name, no hand-written description). Internal state stays
  `appScope.durableSignal()`/`appScope.durable()` — the surface is curated. `src/model/graph.ts` is *disposable
  logic*: the cell graph, built by `hotCellGraph()` and rebuilt over the roots on every hot edit.
  UI components in `src/ui/` are freely hot-swappable, read cells through the `graph()` accessor
  (never importing one directly), and bind controls through `ControlSlider`/`ControlToggle`
  (bounds from the control's meta — never re-state min/max in JSX) or a hand-rolled binding for
  shapes those don't fit.
- **Thread the scope.** `appScope` (src/model/store.ts) qualifies every declaration —
  `control({ scope: appScope, … })`, `appScope.durable(…)`/`appScope.durableSignal(…)`,
  `cell(deps, compute, { scope: appScope })`, `action({ scope: appScope, … })` — and names the
  graph key and the agent toolkit. It is what lets this app share a document with other aiui
  apps (mounted in a gallery shell, imported as a library) without colliding on the
  window-global registries. Never declare an unscoped control/cell/action; see the user guide's
  "Composing bigger apps" for the model.
- **Declaring IS exposing.** Every `control()` is settable and every `action()` is a real named
  agent tool automatically via `registerStandardTools` (`report`/`set`/`locate` + one tool per
  action). Do NOT hand-write get-params/set-params tools; add an `action({ name, run })` next to
  the feature for verbs, and reserve `kit.registerTool` for the rare genuinely-bespoke case.
- **Test the surface with the cells.** `resetControlSurface()` in afterEach (controls are
  module-and-window state), build cells inside `cellHarness`, probe each input — see
  `scenery.test.ts`.
- The dev server runs via `npm run dev` (plain `vite`). Put the app in the shared session
  browser with `aiui open http://localhost:5173` (it starts the browser if needed). The intent
  client reaches the channel on its own (it is served by the channel at `/intent/`), so the app
  itself needs no channel wiring.
- This is a standalone git repo scaffolded for the user; commit freely — history here belongs to
  their sandbox and goes nowhere else.

Methodology docs (user guide, playbook, design choices, hard-won details):
<https://habemus-papadum.github.io/pdum_aiui/guide/frontend-user-guide>

## Hard-won: a test that stops testing is worse than one that never existed

Found while tightening the session graph's ghost-node rules, and general enough
to be worth the space here.

Changing what the layout renders broke two tests. One failed loudly. **The other
had silently become a tautology** and stayed green:

```ts
// The ghost is no longer rendered, so `find(...)` is undefined — and
// `expect(undefined).not.toBe(0)` passes for entirely the wrong reason.
expect(l.bars.find((b) => b.id === "empty")?.rowIndex).not.toBe(
  l.bars.find((b) => b.id === "real")?.rowIndex,
);
```

The optional chain is what does the damage. `?.` was added to satisfy Biome's
`noNonNullAssertion`, and it converted "these two bars are on different rows"
into "undefined is not zero" — a check that can never fail, on a fixture that no
longer contains what it was written to inspect. It survives lint, typecheck,
CI, and review, because a passing test reads as coverage.

Two habits that catch it, both cheap:

- **Assert existence before asserting about a property.** `expect(bar).toBeDefined()`
  on its own line, then the real claim. One extra line converts a silent pass
  into a named failure.
- **Prefer `?.` over `!` in assertions only when the absence is itself part of
  the claim.** Where the value must exist for the test to mean anything, a
  non-null assertion that throws is *more* honest than an optional chain that
  quietly yields `undefined` — Biome's warning is about production safety, and
  a test is not production.

The generalisation: when a change to fixtures or rendering rules makes a test's
subject disappear, negative assertions (`not.toBe`, `not.toEqual`,
`toHaveLength(0)`) turn vacuously true. After changing what a function emits,
grep the tests for the removed thing rather than trusting a green run.
