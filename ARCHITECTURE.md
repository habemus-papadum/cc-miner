# Where cc-miner is going

The target shape, and the decisions that fix it. Written 2026-07-31, after the cleanup pass in
[`CLEANUP-PLAN.md`](./CLEANUP-PLAN.md) and before any of the new work. The staged execution order is
[`PLAN.md`](./PLAN.md).

This document is for **why**. It records the alternatives that were weighed and rejected, because
the decisions below are all reversible-looking and expensive to reverse.

---

## 1. Three tiers

| tier | owns | runs as |
| --- | --- | --- |
| **renderer** | every screen, all navigation, all view state | a browser tab **and** an Electron window — one build, never two |
| **host** | the corpus, queries, long jobs, filesystem watching | `node server/duckdb-host.mjs` in a checkout; a `utilityProcess` inside the packaged app — **one implementation** |
| **CLIs** | mining, export, serving | the checkout. The ones the UI can invoke are **also** in the bundle, and are the same program |

Two-thirds of this already exists. `src/host.ts` sniffs the shell at runtime rather than at build
time, so the renderer is genuinely one artifact; `electron/duckdb-sidecar.mjs` runs the *unchanged*
host program, so `pnpm serve` and the `.dmg` cannot drift.

What is missing is the rest of the middle tier and all of the top:

- the host answers **queries** and nothing else — it cannot do work, and it cannot push
- there is **one screen**, so there is no navigation to have an opinion about
- the CLIs are **not in the bundle**, so nothing in the app can invoke them

The eventual browser deployment is a tab against a running host. Local mode — the corpus fetched as
bytes into duckdb-wasm — is a dev-only affordance today (`import.meta.env.DEV`) and is on a path to
removal, but not yet; see D9.

---

## 2. Invariants that carry forward

Each of these was arrived at by doing the opposite first, and each extends to the new work in a way
that decides something below.

| # | invariant | what it cost to learn | extends to |
| --- | --- | --- | --- |
| I1 | **The origin tells the page where the data is; the page never derives it.** | `quack:${location.host}/quack` is right over http and becomes a TCP hostname under `app://`. Failed by *hanging* — no request, no error. | every new endpoint: jobs, events. They are advertised, never constructed |
| I2 | **One host implementation under both shells.** | — (held from the start, and the reason the sidecar runs the host verbatim) | jobs and the watcher live in the **host**, not the Electron shell |
| I3 | **No IPC, no preload, no menu.** | each is a place the two shells can start behaving differently | navigation lives entirely in the renderer |
| I4 | **No silent fallback between data modes.** | a stale local corpus standing in for the real one is invisible in the UI and expensive in trust | a push must never make a stale snapshot *look* refreshed |
| I5 | **Never a build-time path to the corpus.** | an eager `import.meta.glob` compiled 121 personal transcripts into a shipped `.dmg` (asar 89.6 → 128.5 MB) | job output and watch events are runtime-only, same as the corpus |
| I6 | **The socket is the authority, not the pid.** | a recycled pid made every launch trust a port with nothing on it; presented three processes from the cause | any future "is the host up?" check, including from the UI |

---

## 3. Decisions

### D1 — One window, client-side routing

**Decided:** one `BrowserWindow`, screens as client-side routes.

The intuition to check was that routing "ties up resources". Here it is the reverse. A second
`BrowserWindow` is a second renderer: a second duckdb-wasm instance, a second Mosaic `Coordinator`,
a second connection to the host, a second full boot through `store.ts`. It also requires the shell
to know what a screen *is* — a menu or IPC — which breaks **I3**.

Client-side routing costs close to nothing here for a reason specific to this app: **the expensive
state is not in the component tree.** `store.ts:308` connects the Mosaic clients at boot as durable
roots, and the engine, coordinator, crossfilter and cells all live in `appScope`, outside Solid's
ownership. Unmounting the dashboard disposes the DOM and component-local effects (e.g.
`SessionTimeline.tsx:124`'s `ResizeObserver`) and nothing else. Returning is instant, with no
re-query and no re-boot.

Solid has no `<KeepAlive>`, so unmounted screens genuinely cost zero. Many screens cost **bytes**,
not runtime, and `import()` per screen fixes bytes.

### D2 — Routes are for modes, not for depth

**Decided:** a route is a *screen*. Drill-down stays in-page state.

`App.tsx` already descends corpus → project → session → turn → block within one screen, and that is
right: those are views of one question. Give each a route and the back button becomes "undo my last
click", fighting the crossfilter for ownership of the same gesture.

What goes where:

| | |
| --- | --- |
| **`pushState`** | screen changes — `/`, `/diagnostics`, `/import`, `/settings` |
| **`replaceState`** | shareable-but-not-historical state |
| **not in the URL** | fold / expand / `focusedSession` (`model/view-state.ts`), and every crossfilter brush |

That yields four to six routes, not "many, many". `?source=` stays as it is: `setSourceMode`
(`store.ts:167`) assigns `location.href` with the search param changed and the pathname preserved,
which is a deliberate full reload — the connector, the registered files and every cached table
belong to the old source.

**Session permalinks (`/session/<id>`) are explicitly not being built yet.** They would promote the
drill-down from state to screen, and that is a bigger decision than it looks: `focusedSession` is
deliberately *not* the crossfilter, and a URL that owns it would have to answer what happens when
the session is filtered out.

### D3 — Real paths, and one narrowed fallback in the `app://` handler

**Decided:** history paths, not hash routes.

Paths work unchanged in `pnpm dev` and `pnpm preview` — Vite does SPA fallback. They break in
exactly one place: `electron/app-scheme.mjs:182` deliberately has **no** SPA fallback, so a reload
on `/settings` in the packaged app 404s into a blank window.

That comment's reasoning is sound and must survive: a miss on an asset should stay a miss, because
answering it with `index.html` turns a missing chunk into an unexplained blank window. The narrow
fix preserves it — fall back to `index.html` **only** for `GET` requests whose `Accept` includes
`text/html`. Navigations always ask for HTML; asset fetches never do.

Hash routing (`#/settings`) would sidestep this entirely and needs no server change. Rejected
because the browser tab is a first-class deployment and its URLs are user-visible.

**This is the first thing that makes the third mount genuinely differ from the other two**, so it
needs a test the dev servers cannot provide: `electron/smoke.mjs` already drives the packaged app
over CDP, and "navigate to a second screen, *reload*, assert it renders" is exactly that check.

### D4 — A hand-rolled router, for now

**Decided:** a `route` signal fed by `popstate`, plus `navigate()`. Roughly thirty lines.

`@solidjs/router` is the expected answer and is what a new contributor would reach for. For four to
six flat screens it buys nested layouts and lazy loading that are not needed yet, and it introduces
a second store of navigation state alongside `appScope` — which matters here because `hotCellGraph`
rebuilds the graph on every hot edit and components read `graph().x` through a stable accessor
precisely so they can never hold a stale reference.

Revisit the moment nested layouts or route-level data loading are real. This is a deliberately cheap
decision to reverse.

### D5 — The back affordance is rendered, not shell-provided

History-based routing is required regardless, because in a browser tab the back button exists and
people will press it.

Given that, Electron is nearly free: `history.back()` works in a chromeless window. What does *not*
work is the **keyboard** — Cmd+← is handled by browser chrome that does not exist here, and macOS
swipe navigation needs opt-in. Adding a menu to get the accelerator would break **I3**.

So the affordance is a component. That is the better outcome, not a compromise: it exists
identically in both shells, needs no menu and no IPC, and cannot diverge. With a shallow tree it
should be a **labelled breadcrumb** (`‹ Dashboard`) rather than a bare chevron — naming the
destination beats a generic arrow when there are five screens.

### D6 — Jobs live in the host, and a job runs the real CLI

**Decided:** the job runner is part of `server/duckdb-host.mjs`, and a job spawns the CLI as a child
process.

In the Electron shell it would be unreachable from `pnpm dev` + `pnpm serve`, which rebuilds exactly
the two-implementations problem **I2** exists to prevent.

Spawning the CLI rather than calling a library function in-process buys three things:

- the CLI stays the **single** implementation of mining — no second path that can drift from it
- a mine is CPU-heavy, and DuckDB queries must stay answerable throughout; a separate process is
  what guarantees that, which a worker thread sharing the event loop would not
- it is the same mechanism as "run a CLI from the app with flags", so there is one story

`electron/duckdb-sidecar.mjs` is the working template — idempotent `ensureHost`, fork, advertise via
a runtime file. `protocol.handle` supports POST, so **no IPC is needed** and **I3** survives.

Shape: `POST /__jobs {kind, args}` → `{id}`; `GET /__jobs/:id` → status; progress over the event
stream (D7). Job state in memory plus a small file, so a renderer reload can re-attach to a running
job rather than orphan it.

### D7 — Server-sent events before WebSockets

**Decided:** SSE, at an endpoint the lookup advertises.

Both the traffic patterns in view — job progress, and "activity detected on this machine" — are
server→client only. SSE has no framing to get wrong and reconnects on its own. WebSockets are a
small step up from there if the client ever needs to send, and nothing about this choice forecloses
it.

The endpoint is added to `hostInfo()` (`server/host-runtime.mjs:181`) beside `quackUri`, and the
page uses it verbatim. This is **I1**, and it is the one thing to be rigid about: deriving an
endpoint from `location` is precisely the failure that hung with no request and no error.

One wrinkle to expect rather than discover: `EventSource` cannot set headers, so the host token has
to travel in the query string.

**A push must not silently refresh anything.** Under **I4**, a v1 that pushes *notice* — "3 sessions
since your snapshot" — and lets the user trigger a re-mine is the honest design. Incremental append
into a Hive-partitioned corpus is a much larger question than the transport, and conflating them
would mean shipping a refresh path nobody can characterise.

### D8 — One package, and it comes first

**Decided:** fold `cc-assay` into `pdum-cc-miner` before the job runner is built.

Two blockers, both recorded during the cleanup review and both independent of code shape:

- `electron-builder.yml`'s `files` is an **allowlist** that excludes `node_modules/@habemus-papadum/**`.
  Anything under that scope is absent from the bundle: it typechecks, passes in dev, and fails at
  `require` time inside the `.dmg`.
- `cc-assay` is TypeScript run through `tsx`, which is a devDependency. **The packaged app has no
  transpiler.**

So "run the miner from the UI" is blocked on packaging, not on plumbing, and both blockers dissolve
in a single package whose own files are already in the allowlist via `server/**`. Doing the job
runner first would mean building it against a module layout that is about to change.

Note the constraint that survives the merge: `server/host-runtime.mjs` is plain `.mjs` and duplicates
`corpusDir()` on purpose, because the Electron main process executes it verbatim out of a packaged
bundle. Anything the main process or the sidecar loads must stay transpiler-free.

### D9 — Local mode stays until the host is genuinely always-on

The payoff for deleting it is smaller than it looks: **duckdb-wasm stays regardless**, because it is
in the page to speak Quack's wire format, not to hold the data. What actually goes is `source.ts`'s
byte-fetching path, the `/__corpus` route in all three mounts, `selectShards`, and the two-mode
branch in boot.

What it costs is the only thing that renders in a fresh checkout with no host running.

So: keep it until the job runner makes the host something the app can start and supervise, then
remove it in one commit rather than letting it half-rot. Retiring it is Stage F in the plan and is
not committed to yet.

---

## 4. The resource model, stated plainly

Because this is the question that prompted the design, and the answer is not the usual one.

**What routing does not cost.** Screens are components. Unmounting one disposes its DOM and its
owned reactive scope. The engine, the coordinator, the crossfilter, the cells and the durable roots
are all in `appScope` and survive. There is no `<KeepAlive>` to leak through.

**What it does cost, and the rule that keeps it small.** The Mosaic clients are connected at boot
(`store.ts:308-309`) and stay connected whether or not `SessionTimeline` is mounted. Today that is
free: nothing perturbs the crossfilter while you are on another screen. It stops being free the
moment D7 lands, because a push that invalidates the crossfilter would make an off-screen client
re-query.

> **The visibility rule.** Anything that can be invalidated by a push must be able to say "I am not
> visible" — either it disconnects on unmount, or it gates on a visibility signal. Adopt it when the
> first Mosaic client becomes push-driven, not after.

**The trap to avoid while adding screens.** Durable state in `appScope` is keyed by scope and
outlives components *by design* — that is what makes it right for the engine and wrong for a
settings form. Screens should be pure readers of shared state plus ordinary `createSignal` for their
own widgets. A durable root per screen is how "routing is cheap" would stop being true.

**One property worth preserving deliberately.** Boot is view-driven: `graph().dataset` is a cell,
and the load happens because a `CellView` observes it. A screen that does not show the dashboard
therefore does not boot DuckDB — which is what makes a diagnostics screen usable when host mode is
broken. Do not move `ensureLoaded()` to app startup to "simplify" it.

---

## 5. Open, and deliberately not decided

- **Incremental refresh.** What a push should do beyond notify. Needs a characterisation of
  re-reading a Hive-partitioned corpus that does not exist yet.
- **Session permalinks.** See D2 — blocked on what a URL-owned `focusedSession` means under a
  filter.
- **Multiple windows, ever.** Only if two views must be seen at once. Everything in D1 says pay for
  it then, not now.
- **Which CLIs ship.** `mine` must, since the UI invokes it. `serve` already does. Whether `export`
  ships separately is a question for after the merge, when there may not be separate CLIs.
