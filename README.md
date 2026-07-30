# pdum-cc-miner

Understand your own Claude Code usage: cost per turn, where the money actually goes, and
whether a session was time well spent.

A desktop app (Electron) that is also a plain web app — the same renderer, the same build,
told at runtime which shell it is in. Two packages:

| | |
| --- | --- |
| [`pdum-cc-miner/`](./pdum-cc-miner) | the app — SolidJS + Mosaic + DuckDB, in a browser tab or a window |
| [`cc-assay/`](./cc-assay) | the miner — turns `~/.claude` transcripts into Parquet |

```sh
pnpm install
pnpm -C cc-assay mine              # mine your transcripts → ~/.cache/cc-miner
pnpm -C pdum-cc-miner dev          # browser, http://localhost:5173
pnpm -C pdum-cc-miner dev:electron # …or an Electron window
```

## The corpus lives outside the repo, and outside the app

A mined corpus carries conversation text, project names, branch names and working directory paths.
It is personal telemetry, so it lives in **`~/.cache/cc-miner`** — never in the working tree, and
never inside a build artifact. Both data modes and both hosts read it from there at run time:
the browser and the packaged app fetch it over `/__corpus`, and the DuckDB host reads the same
directory directly. `PDUM_CC_MINER_CORPUS` overrides the location; `XDG_CACHE_HOME` is honoured.

This is enforced by construction rather than by rule, which it needs to be. The corpus used to sit
in `pdum-cc-miner/src/data` and reach the renderer through an **eager `import.meta.glob`** — a
build-time glob, so `vite build` compiled every Parquet file into the bundle. Measured: 121 session
replay files in `dist/assets`, and an `app.asar` of 128.5 MB against 89.6 MB without. Anyone handed
that `.dmg` got the builder's transcripts. The gitignore protected the repo; nothing protected the
artifact. Now the build never sees the data, so it cannot carry it.

Which means a fresh clone starts empty and says so, pointing at `cc-assay mine`. That is the
intended first run.

## Two data modes, declared rather than discovered

Both read the same corpus from `~/.cache/cc-miner`. They differ only in **where the query runs**,
which is what makes comparing them meaningful:

| mode | where queries run | needs a server |
| --- | --- | --- |
| **local** (default) | duckdb-wasm in the page, over shards fetched from `/__corpus` | no |
| **host** | a native DuckDB answering over [Quack](https://duckdb.org/docs/current/quack/overview) | yes — `pnpm serve`, or the packaged app's own sidecar |

Pick with the switcher in the app header, or `?source=local` / `?source=host`; the choice is
remembered and switching reloads. **There is no fallback in either direction.** Asking for `host`
with no host running is an error, never a quiet downgrade — a stale local corpus standing in for
the real one is invisible in the UI and expensive in trust.

## Packaging

```sh
pnpm -C pdum-cc-miner pack:mac      # .dmg + .zip + latest-mac.yml
pnpm -C pdum-cc-miner pack:linux    # .AppImage + .deb   (must run on Linux)
```

See [`pdum-cc-miner/README.md`](./pdum-cc-miner/README.md) for the size budget, the signing and
notarization requirements, and the one entitlement that turns out to be load-bearing.

## What is next

[`DEPLOYMENT.md`](./DEPLOYMENT.md) — the signing and notarization steps (an Apple Developer
account is all that is missing), what is measured versus what has never run, and the plan to
extract the Electron and DuckDB/Mosaic infrastructure into their own packages.

## The aiui dependency

The app is built on [`@habemus-papadum/*`](https://github.com/habemus-papadum/pdum_aiui) —
`aiui-viz` for the cell graph, the control surface and the agent tools, `aiui-source-processor`
for the build-time compiler pass. They are consumed from **npm** at the versions in each manifest.

The root `devDependencies` are a superset of what this repo actually uses — worth pruning once the
toolchain here settles.

## Developing against the aiui packages' source

Because `@habemus-papadum/*` arrives from npm, a one-line fix in one of them is otherwise a
publish away. Three levers, smallest first:

```sh
pnpm link:up                     # every aiui dep → ../pdum_aiui source
pnpm link:up aiui-viz            # just that one
pnpm link:up --path ~/work/aiui  # an upstream checkout elsewhere
pnpm upstream                    # what is linked right now
pnpm unlink:up                   # back to the published versions
```

`link:up` defaults to a **sibling** `../pdum_aiui`, which is the layout to keep.
It writes a fenced `overrides` block into `pnpm-workspace.yaml` and reinstalls;
the linked package then resolves to its `src/index.ts`, with HMR straight from
source. Verified: typecheck, build and tests all pass linked.

Overrides rather than `pnpm link` on purpose — an override redirects *every*
resolution of a name, direct or transitive, so it cannot produce two copies of
one library. See the header of `scripts/upstream.mjs`.

**A link is local state, never committed.** It names a path that exists on one
machine. `pnpm upstream:check` runs in CI and fails the build if one survives
into a commit, so the mistake is a sentence rather than a broken clone.

For anything longer-lived than an afternoon, prefer publishing a canary from
`pdum_aiui` — `gh workflow run release.yml -f canary=true`, which publishes
`X.Y.Z-canary.<sha>` under the `canary` dist-tag — and depend on that real
version. (Not a `canary.yml`: npm trusted publishing matches on the exact
workflow filename, so the canary has to live inside `release.yml`.)
