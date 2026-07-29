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
pnpm -C cc-assay normalize -- --out ../pdum-cc-miner/src/data   # make your own corpus
pnpm -C pdum-cc-miner dev                                       # browser, http://localhost:5173
pnpm -C pdum-cc-miner dev:electron                              # …or an Electron window
```

## It ships with no data, on purpose

`pdum-cc-miner/src/data` is gitignored and always will be. A mined corpus carries conversation
text, project names, branch names and working directory paths — it is personal telemetry, and it
belongs on your disk and nowhere else. Run `cc-assay` and you have your own in a minute or two.

Which means a fresh clone starts empty and says so. That is the intended first run.

## Two data modes, declared rather than discovered

| mode | where queries run | needs a server |
| --- | --- | --- |
| **local** (default) | Parquet you generated, duckdb-wasm in the page | no |
| **host** | a native DuckDB answering over [Quack](https://duckdb.org/docs/current/quack/overview) | yes — `pnpm serve`, or the packaged app's own sidecar |

Pick with `?source=local` / `?source=host`; the choice is remembered. **There is no fallback in
either direction.** Asking for `host` with no host running is an error, never a quiet downgrade —
a stale local corpus standing in for the real one is invisible in the UI and expensive in trust.

## Packaging

```sh
pnpm -C pdum-cc-miner pack:mac      # .dmg + .zip + latest-mac.yml
pnpm -C pdum-cc-miner pack:linux    # .AppImage + .deb   (must run on Linux)
```

See [`pdum-cc-miner/README.md`](./pdum-cc-miner/README.md) for the size budget, the signing and
notarization requirements, and the one entitlement that turns out to be load-bearing.

## Provenance

Evicted from [`habemus-papadum/pdum_aiui`](https://github.com/habemus-papadum/pdum_aiui) by its
`scripts/evict.mjs`, which rewrites the `workspace:^` dependencies to published npm ranges. The
`@habemus-papadum/*` packages this depends on are consumed from npm at the versions in each
manifest.

The root `devDependencies` are carried wholesale from the source repo and are a superset — worth
pruning once the toolchain here settles.
