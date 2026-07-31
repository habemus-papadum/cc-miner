# Extraction: what would move, what must survive, what blocks it

Written 2026-07-30 from a full read of the code, not from `DEPLOYMENT.md` §3 — which turned out to
be wrong in one important way (§0). **Nothing is being extracted yet.** This is the inventory that
makes a later extraction a mechanical job rather than an archaeology one.

The three targets, from `DEPLOYMENT.md` §3:

| package | what it is |
| --- | --- |
| `aiui-electron` | the desktop shell: custom-scheme serving, dev/prod split, packaging, signing, updates |
| `aiui-duckdb-host` | a native DuckDB answering over Quack, its discovery protocol, and its three mounts |
| `quackConnector` | ~10 lines that make Mosaic send SQL to a remote DuckDB instead of moving tables |

---

## 0. Where `DEPLOYMENT.md` §3 was wrong

> `aiui-electron` — *"none of it mentions cc-miner"*

**False, and by a wide margin.** `electron/app-scheme.mjs` hardcodes `app://pdum-cc-miner`;
`electron/main.mjs` sets the app name, window title and `#14161a` background; `electron/updater.mjs`
puts the product name and "about 190 MB" in a user-facing dialog; `electron/make-icon.mjs` draws
cc-miner's logo; and **eight distinct `PDUM_CC_MINER_*` environment variables** are read across the
five files. §5 below enumerates every one.

Two smaller corrections:

- §3 files `electron/duckdb-sidecar.mjs` under `aiui-duckdb-host`, but it imports `electron`. See §4.
- §3 lists `pack.mjs` for its `extraMetadata` trick — 2 lines of 434. The genuinely expensive parts
  are `gatherSigning()`, `stapleDmgs()`, `publishArtifacts()` and `findAsar()`. It omits
  `electron-builder.yml` and `build/entitlements.mac.plist` entirely, which between them carry most
  of the measured lessons in §6.

The lesson is the same one this repo keeps relearning: **a doc that describes an aspiration in the
present tense will be believed.**

---

## 1. `aiui-electron`

### Files that move

| file | lines | notes |
| --- | --- | --- |
| `electron/app-scheme.mjs` | 207 | whole file; `serveApp()` needs the seam in §4 first |
| `electron/main.mjs` | 147 | becomes a `createElectronApp(options)` factory, not a file |
| `electron/pack.mjs` | 434 | becomes a library + thin bin |
| `electron/updater.mjs` | 109 | one export, `initUpdater()` |
| `electron/dev.mjs` | 67 | unlisted in §3; the Vite-node-API-not-CLI lesson is generic |
| `electron/make-icon.mjs` | 122 | **only the PNG encoder moves**; the logo geometry stays |
| `electron/smoke.mjs` | 278 | the CDP harness is generic; the fingerprint is not |
| `electron-builder.yml` | 176 | ships as a **template/preset**, never a file to copy |
| `build/entitlements.mac.plist` | 58 | ships as a **default asset** with app-local justifications |

### Genuinely generic, and the reason to bother

- `gatherSigning()` — the `Developer ID Application` refusal, the prefix-vs-qualifier asymmetry.
- `stapleDmgs()` — submit, **check the verdict not the exit code**, staple, re-validate.
- `publishArtifacts()` — build → staple → publish, with the create/`--clobber` matrix race handled.
- `findAsar()` / `assertAsarBudget()` — discovers the product name rather than writing it down.
- `resolveAsset()` — resolved-prefix containment.
- `registerAppScheme()` — the five privilege flags, and *when* it must be called.
- The PNG encoder in `make-icon.mjs` (`chunk`, `crc32`, IHDR/IDAT/IEND) and `bgCoverage`.

---

## 2. `aiui-duckdb-host`

| file | lines | notes |
| --- | --- | --- |
| `server/host-runtime.mjs` | 254 | discovery, `hostInfo`, `hostPort`, `corpusFile`, the Connect mount |
| `server/duckdb-host.mjs` | 331 | the standalone program; `assertAccepting` and `freePort` should be exported |
| `server/vite-plugin.ts` | 32 | unlisted in §3, but it is mounts 2 and 3 of 3 — cannot be left behind |
| `electron/duckdb-sidecar.mjs` | 174 | belongs here, but imports `electron` — see §4 |
| `server/host-runtime.test.ts` | 126 | the `quackUri` contract and the whole `hostPort` suite |
| `server/corpus-route.test.ts` | 75 | the traversal refusal table |

**`assertAccepting()` is the single most load-bearing function in the repo.** See §6, item 26.

---

## 3. `quackConnector`

Only three things actually move: `quackConnector()`, its private `wrap()`, and the options type.

Two things in `src/model/quack.ts` belong to **`aiui-duckdb-host`**, not here: `fetchHostInfo()` and
the `HostInfo` type are the client half of `/__duckdb-host`, and must share the route constant with
`mountHostRoutes` rather than re-typing it. `replayFileSql` was dead and has been deleted.

---

## 4. The package graph, and the one seam to cut first

Import edges today:

```
electron/main.mjs      → app-scheme.mjs, duckdb-sidecar.mjs, updater.mjs
electron/app-scheme.mjs → server/host-runtime.mjs  AND  duckdb-sidecar.mjs   ← the problem
electron/duckdb-sidecar.mjs → electron, server/host-runtime.mjs
server/duckdb-host.mjs  → server/host-runtime.mjs
server/vite-plugin.ts   → server/host-runtime.mjs
```

Direction is **Electron shell → DuckDB host**. Two consequences:

**(a) `serveApp()` hardcodes two DuckDB routes.** Until `/__duckdb-host` and `/__corpus` become
*injected handlers*, `aiui-electron` depends on `aiui-duckdb-host` permanently and the two can never
be released independently. **This is the highest-value refactor to do before extraction** — and it
is what would finally make §3's "none of it mentions cc-miner" true.

**(b) `duckdb-sidecar.mjs` imports `electron`.** Resolution: an `aiui-duckdb-host/electron` subpath
with `electron` as an *optional* peer dependency. Do not make the package peer-depend on Electron at
its root — that breaks `pnpm serve` and the Vite plugin for browser-only consumers.

With (a) cut, all three packages publish independently. Without it: `aiui-duckdb-host` first.

---

## 5. cc-miner couplings to parameterise

**Eight `PDUM_CC_MINER_*` variables** — `_URL`, `_CDP_PORT`, `_DEVTOOLS`, `_TRACE_SCHEME`,
`_VERSION`, `_PUBLISH`, `_RELEASE_REPO`, `_UPDATE_URL`, plus `_CORPUS`, `_HOST_RUNTIME`, `_FLAT`,
`_S3_PREFIX`, `_S3_PROFILE` on the host side. **A single `envPrefix` option collapses all of them**
and is strongly preferred over thirteen separate names.

| coupling | where | option |
| --- | --- | --- |
| `app://pdum-cc-miner` | `app-scheme.mjs` | `appOrigin` |
| scheme literal `"app"` | `app-scheme.mjs` | `scheme`, default `"app"` |
| `.parquet` in the content-type table | `app-scheme.mjs` | `extraContentTypes` |
| no SPA fallback | `app-scheme.mjs` | `spaFallback`, default `false` — **keep the comment** |
| `app.setName`, window title | `main.mjs` | `appName` (required), `windowTitle` |
| `#14161a` background | `main.mjs` | `backgroundColor` — the flash-of-white rationale must travel |
| `1600×1000`, CDP `9333`/`9422` | `main.mjs`, `dev.mjs` | `windowSize`, `defaultCdpPort` (keep the "not 9222" note) |
| `BUDGET_MB = 140` | `pack.mjs` | `asarBudgetMb` (**required, no default** — it is a per-app tripwire) |
| `npx vite build` | `pack.mjs` | `buildRenderer` |
| release-note body, dialog strings, "about 190 MB" | `pack.mjs`, `updater.mjs` | `productName`, `releaseNotes()`, `downloadSizeHint` |
| `~/.cache/cc-miner` | `host-runtime.mjs` | `cacheDirName` — keep the one-spelling-everywhere rationale |
| `/__corpus`, `/__duckdb-host` | 3 files, 2 packages | **export the constants; never re-type them** |
| `.staging` exclusion | `host-runtime.mjs` | `excludedTopLevel` |
| the 8 `GRAINS` | `duckdb-host.mjs` | `views: {name, glob}[]`, supplied by the app |
| `LAYOUT_GLOB`, `FLAT_GLOB` | `duckdb-host.mjs` | `layoutGlob`; drop the flat one |
| `cc_s3` secret name, `EXTENSIONS` | `duckdb-host.mjs` | `secretName`, `extensions` |
| `$aiui$` dollar tag | `quack.ts` | `dollarTag`, default `"aiui"` |

**Do NOT parameterise `127.0.0.1`.** It appears in `host-runtime.mjs`, `duckdb-host.mjs` and two
tests, and it is a correctness constraint — `quack_serve` binds the IPv4 loopback only, and
`localhost` may resolve `::1` first. It is not a preference.

---

## 6. Load-bearing behaviours that must survive

The full catalogue is 66 items. **The comments are the artifact** — an extraction that carries the
code and drops the prose loses the entire point. These are the ones that would cost the most to
rediscover:

**Packaging and signing**

1. **sign → notarize → staple**, and the dmg notarized *separately, after* electron-builder — it
   staples the `.app` then wraps it, so the dmg gets no ticket of its own.
2. **`--publish never` always**, upload after stapling — electron-builder starts each upload from
   `artifactCreated` with an already-started promise, so it would publish unstapled bytes.
3. **`notarytool submit --wait` exits 0 on rejection.** Check for `status: Accepted`, never the exit
   code.
4. **`mac.identity` absent from the yml, never `null`** — null reads as *signing disabled* and
   silently produced an unsigned CI release.
5. **`dmg.sign: true`** — a ticket without a signature still fails Apple's own `spctl` check.
6. **`dmg.writeUpdateInfo: false`** — stapling appends ~2 KB *after* the checksum is recorded.
7. **`zip` beside `dmg`** — `latest-mac.yml` is only generated when a zip target exists.
8. **`extraMetadata` rewrite of `main` and `version`**, unconditionally — `X.Y.Z+dev` compares
   *equal* to `X.Y.Z` because semver ignores build metadata, so an updater would never fire. Forever.
9. **`files` is an allowlist, excluded by name** — dropping `node_modules` wholesale also drops
   electron-updater's 8 transitive deps, which fail at `require` time inside the bundle.
10. **`disable-library-validation`** — without it the app launches, local mode renders everything,
    and *only host mode dies*. Bundling the extensions does not help: DuckDB verifies its own
    signature and `codesign` appends to the Mach-O.

**Runtime**

11. **`assertAccepting` is a BARRIER, not a health check.** The runtime file is the advertisement;
    writing it before the accept loop is running produced `ERR_CONNECTION_REFUSED` on a port that
    was entirely correct. Connect, *then* advertise.
12. **Never derive an endpoint** — `quack:${location.host}` became `quack:cc-miner/quack` under
    `app://` and failed by *hanging*, with no request and no error.
13. **`hostPort` advertises what was BOUND, not what was requested.**
14. **`runtimeFile()` is a function, not a constant** — ESM would freeze it before the shell could
    set the env var.
15. **The runtime file is read per request** — start order stops mattering.
16. **Lazy sidecar start, no IPC** — the lookup the renderer already makes *is* the trigger.
17. **`utilityProcess`, not `child_process`** — `@duckdb/node-api` loads there as ESM with no rebuild.
18. **EPIPE guard on stdout/stderr, first in the process** — a log write killed the main process and
    took the sidecar with it.
19. **`registerSchemesAsPrivileged` before `whenReady`** — a late call is silently ignored.
20. **Path containment by resolved prefix, twice** — a substring blocklist loses to encoding.
21. **`corpusDir` is deliberately duplicated, never imported** — see §7.
22. **All grains missing is fatal; one missing grain is not** — eight empty views read as "you have
    no usage" rather than "I looked in the wrong place".

**Connector**

23. **The SQL travels, not the table** — `ATTACH` did no pushdown: 5.26 GB and 1853 round trips for
    a `count(*)` that `quack_query` answered in 5 ms.
24. **Delegate to `wasmConnector`** — returning duckdb-wasm's arrow table breaks Mosaic, which wants
    flechette.
25. **`$aiui$` dollar quoting** — any escaping scheme that reasons about quotes eventually meets one
    it mishandles.

---

## 7. Blockers and open questions

1. **`serveApp()`'s hardcoded routes** — §4(a). Do this first.
2. **The `electron-builder.yml` allowlist excludes `@habemus-papadum/**`.** Extracting these files
   into `@habemus-papadum/*` packages would make the packaged app **exclude the very code it runs** —
   it would typecheck, pass in dev, and fail at `require` time inside the `.dmg`. The allowlist needs
   an exception and the asar budget re-measuring. **This is a hard blocker, not a detail.**
3. **The EPIPE guard's ordering cannot be an option.** It must run before *any* import that logs. If
   `main.mjs` becomes `import { createElectronApp } from "aiui-electron"`, the guard runs at the
   package's module-eval time — after the app's own top-level imports. Either export a
   side-effecting `aiui-electron/guard` the app imports first, or move it into the factory and
   document the ordering. Getting this wrong silently reintroduces the crash.
4. **`runtimeFile()` laziness becomes a cross-package initialisation contract.** Prefer
   `configureRuntime({ dir })` over the app poking `process.env`.
5. **`PDUM_CC_MINER_CORPUS` is read by `cc-assay` too** — a third party outside both packages.
   Renaming it is a cross-repo change.
6. **`corpusDir` is triplicated on purpose.** Do not "fix" it into an import; blocker 2 is exactly
   why. A package-level `corpusDir` is only safe once the allowlist admits the package.
7. **`GRAINS` exists in four places** — `duckdb-host.mjs`, `cc-assay/src/export.ts`,
   `cc-assay/src/parquet.ts`, `src/model/store.ts`. Parameterising one does not fix the drift.
8. **`electron-builder.yml` cannot be a package file** — one document mixing generic lessons
   (comments) with app identity. Whatever ships, the comments are the value.
9. **The second-consumer gate is unmet.** `DEPLOYMENT.md` §3: "A trivial second app must run on
   these three packages before extraction counts as done." Several parameterisations above
   (`views`, `layoutGlob`, `extraContentTypes`) are *guesses* at what a second consumer needs. They
   should be driven by that app, not designed ahead of it.
10. **Linux is built but the sidecar is unverified there.** Extraction does not verify it, and the
    new package would be asserting portability it has not measured.
