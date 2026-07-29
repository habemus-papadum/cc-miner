# cc-miner

Your own Claude Code usage: cost per turn, where it goes, and whether a session was time well spent.

Wired to the workspace (`workspace:^`, no npm install of aiui packages, no build step), and staged
for eviction to its own repo — see [`scripts/evict.mjs`](../../scripts/evict.mjs). Its data comes
from [`cc-assay`](../cc-assay) next door.

## Two hosts, one app

cc-miner runs in a browser tab or in an Electron window. Electron is not a different build — it is
a different window pointed at the same renderer. Nothing in `src/` branches on a build flag to tell
them apart; `src/host.ts` asks at runtime, which is what keeps that claim checkable.

```sh
pnpm serve           # terminal 1 — the DuckDB host (host mode only; see below)
pnpm dev             # terminal 2 — browser host, http://localhost:5173
pnpm dev:electron    #     …or the Electron host, http://localhost:5179 in a window
pnpm claude          # terminal 3 — Claude Code with the aiui channel + session browser
```

## The production build

One `vite build` produces one `dist/`, and that same directory is both the static web deploy and
the payload inside the desktop package. It is not a dev-only convenience:

```sh
pnpm build           # → dist/  (relative base, so it works from any path)
pnpm preview         # serve the BUILT app, host routes included
```

`pnpm preview` mounts the same `/__duckdb-host` and `/quack` routes the dev server does
(`server/host-runtime.mjs`, one implementation), so **the built app can run host mode too**.
Without that, host mode would silently be a dev-server-only feature — the sort of gap that stays
invisible until someone ships.

Verified at a matched viewport: the built app and the dev server agree exactly in local mode —
29,323 turns, 102 sessions, 33 charts, 59,630 marks — and the built app reaches the full corpus in
host mode (30,420 turns, 104 sessions).

## Packaging

```sh
pnpm pack:dir      # release/mac-arm64/cc-miner.app — fastest, for checking a change
pnpm pack:mac      # + .dmg, .zip and latest-mac.yml
pnpm pack:linux    # + .AppImage, .deb and latest-linux.yml (must run ON Linux)
```

Two fields in this `package.json` are right for a workspace member and wrong for a desktop app,
and neither may be edited in the tree — `electron/pack.mjs` rewrites both into the bundle's copy
via `extraMetadata`:

- **`main`** is `./src/index.ts`, the library barrel every sibling imports source-first. The
  bundle needs `electron/main.mjs`.
- **`version`** is `X.Y.Z+dev`, the lockstep marker owned by the release pipeline
  ([AGENTS.md](../../AGENTS.md)). It is also a semver trap: comparison **ignores build metadata**,
  so `0.12.0+dev` and `0.12.0` compare *equal* and an updater would never fire. Local builds get
  `0.12.0-dev.<sha>` — a prerelease, which sorts strictly *below* `0.12.0`, so a dev build can
  never look newer than a real release.

### The size budget

| | | |
| --- | --- | --- |
| Electron Framework | 273 MB | irreducible |
| `app.asar` | 108 MB | exactly `dist/` |
| `app.asar.unpacked` | 112 MB | `libduckdb.dylib` — the native engine |
| **installed** | **495 MB** | |
| **dmg / zip** | **192 MB** | what a user downloads |

`files` in `electron-builder.yml` is an allowlist. It has to be: electron-builder adds every
production `dependency` on its own, and cc-miner's are the *renderer's* — solid, mosaic, and
duckdb-wasm's 143 MB — because this package is also a library. Excluding them and putting back
only the native DuckDB took the `.app` from 661 MB to 495 MB.

### Signing and notarization

`electron/pack.mjs` looks for a **`Developer ID Application`** certificate and treats anything
else as unsigned — including the `Apple Development` certificate most Mac dev machines carry.
That is a deliberate refusal, not an oversight: left to auto-discover, electron-builder signs
with whatever it finds, and an `Apple Development` build *looks* signed, passes
`codesign --verify`, runs on the machine that built it, and is rejected by `notarytool` and by
Gatekeeper on every other Mac.

To sign and notarize for real, two things are needed and neither can be derived from the repo:

1. **A `Developer ID Application` certificate.** Requires a paid Apple Developer Program
   membership and the Account Holder / Admin role — a free personal team can only issue
   `Apple Development`. Create it in Xcode (*Settings → Accounts → Manage Certificates → + →
   Developer ID Application*) or at developer.apple.com. In CI, pass it as a base64 `.p12` in
   `CSC_LINK` with `CSC_KEY_PASSWORD`.
2. **Notarization credentials.** Either an App Store Connect API key — `APPLE_API_KEY` (path to
   the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` — or an Apple ID with `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Prefer the API key: no 2FA prompt, so it works
   unattended.

With neither, `pnpm pack:mac` still produces working artifacts and says plainly what they are.

#### The entitlement that is actually required — measured, not predicted

Hardened runtime is mandatory for notarization, and it enables **library validation**: every
Mach-O loaded into the process must be signed by the same Team ID, or by Apple. A controlled pair
of builds, identical but for one key:

| `disable-library-validation` | app launches | host mode |
| --- | --- | --- |
| absent | yes — local mode renders all 33 charts | **fails** |
| present | yes | works — 30,420 turns, 104 sessions |

The failure, in full:

```
dlopen(~/.duckdb/extensions/v1.5.5/osx_arm64/quack.duckdb_extension, 0x0006):
  code signature not valid for use in process
```

Note *which* file. It is **not** `libduckdb.dylib` — electron-builder re-signs everything inside
the bundle with our identity, so the bundled 112 MB engine passes. The blocker is the DuckDB
extension that arrives **at runtime**, downloaded to `~/.duckdb/extensions/` on the first query
and dlopen'd from there. It can never be re-signed by us, because it does not exist at packaging
time.

Bundling the extensions instead is not the escape it looks like: DuckDB verifies its *own*
signature over the extension file, and `codesign` appends to the Mach-O, so re-signing one would
break the check it was meant to satisfy. `com.apple.security.cs.disable-library-validation` is
the answer, and `build/entitlements.mac.plist` justifies each of the four holes it punches.

### Releases and auto-update

`.github/workflows/cc-miner-release.yml` (manual dispatch, `version` + `dry_run`) builds macOS on
an arm64 runner and Linux on ubuntu, and publishes to GitHub Releases.

**Releases go to a dedicated repo, not this one, and that is forced rather than chosen.**
[`release.yml`](../../.github/workflows/release.yml) already owns the GitHub Releases list here —
`vX.Y.Z`, carrying the `.vsix` and the Chrome extension zip. electron-updater asks GitHub for the
*latest release* and then reads `latest-mac.yml` out of it, so the first npm release published
after a cc-miner one would 404 every installed app's update check. Two feeds cannot share one
release list. cc-miner is staged for eviction to its own repo anyway, so its releases start
there.

`releaseType: release` is set explicitly because electron-builder's default is **draft**, and
drafts are invisible to the updater — a release that looks published and updates nobody.

The updater does not download without asking: the archive is ~190 MB, and a desktop tool quietly
consuming that on someone's tethered connection is not a courtesy. Verified against a local feed —
a 0.1.0 build pointed at a server advertising 0.9.9 finds it, reports
`update-available: 0.9.9 (running 0.1.0)`, and then **waits**. `PDUM_CC_MINER_UPDATE_URL` is the hook
that makes that testable without publishing anything.

**Auto-update only works on signed builds.** On macOS the swap is done by Squirrel.Mac, which
verifies the replacement's code signature against the running app's; an unsigned build downloads
successfully and fails to install. So this is configured and its detection half is measured, but
the install half cannot be true until a Developer ID certificate exists.

### Two further size levers

Measured but **not** taken, because both change behaviour and neither is on the critical path:

- **41 MB** — the `mvp` duckdb-wasm bundle. `selectBundle` picks `eh` on every browser since
  ~2021 and always in Electron, so `mvp` is never loaded; dropping it turns a graceful
  degradation into a hard failure on browsers nobody is targeting.
- **28 MB** — the bundled replay corpus ships all 109 sessions while local mode is a 1-month trim
  covering 102.

## Two data modes, declared not discovered

| mode | where queries run | needs a server |
| --- | --- | --- |
| **local** (default) | Parquet shipped with the app, duckdb-wasm in the tab | no |
| **host** | a native DuckDB answering over Quack | yes — `pnpm serve`, or the packaged app's own sidecar |

Pick with `?source=local` / `?source=host`; the choice is remembered. **There is
no fallback in either direction**: asking for `host` with no host running is an
error, never a quiet downgrade to local bytes. A stale local corpus standing in
for the real one is invisible in the UI and expensive in trust.

Local mode carries a **trimmed** corpus — `pnpm -C ../cc-assay export --months 1`
— so the quick-start path stays quick as the real corpus grows.

## The DuckDB host

The app does **not** query Parquet in the tab. A native DuckDB process holds the
data and answers over [Quack](https://duckdb.org/docs/current/quack/overview),
DuckDB's own HTTP remote protocol; the page's duckdb-wasm is kept solely to speak
that protocol. Zero Parquet bytes reach the browser.

```sh
pnpm serve --flat                     # the legacy flat src/data layout
pnpm serve --data <dir>               # a Hive-partitioned corpus on disk
pnpm serve --s3-prefix s3://bucket/cc --s3-profile personal
```

It picks a free port and writes `.aiui-cache/duckdb-host.json`. The page finds it
through one lookup, `GET /__duckdb-host`, which returns the token and the
endpoint to use. **The page never derives that endpoint** — it used to, from
`location.host`, and that was right in a tab and wrong under the packaged app's
`app://pdum-cc-miner/`, where it produced a hostname DuckDB dialled over TCP and the
load hung with no request and no error. Start order still does not matter: the
runtime file is read per request.

### In the packaged app, the app starts it

There is no terminal in a shipped app, so the Electron shell spawns the *same*
`server/duckdb-host.mjs` in a `utilityProcess` — measured: `@duckdb/node-api`
loads there as ESM with no rebuild. It starts **lazily**, on the first
`/__duckdb-host` request, which the renderer only makes in host mode. That is
why this needs no IPC: the existing lookup already happens at exactly the moment
the sidecar is wanted, so a user who stays in local mode never pays for a DuckDB
process.

Where it reads from, in a packaged app:

| | |
| --- | --- |
| `<userData>/corpus` | the default — `~/Library/Application Support/cc-miner/corpus` on macOS |
| `PDUM_CC_MINER_CORPUS` | point at a corpus that already exists |
| `PDUM_CC_MINER_S3_PREFIX` + `PDUM_CC_MINER_S3_PROFILE` | serve from S3 instead |

Both no-corpus cases are named rather than shrugged at — a missing directory is
caught before spawning, and a directory with no Parquet in it fails the host's
boot with the glob it tried, instead of booting eight empty views and letting the
app report that you have no usage.

Why not `ATTACH` the remote catalog and query it like a local table? Because
`ATTACH` does no pushdown at all — a bare `count(*)` over a 272 MB table moved
5.26 GB — while sending the SQL with `quack_query` answered it in 5 ms with ~0
bytes. See [the DuckDB guide](../../docs/guide/duckdb-mosaic).

The two can run at the same time; the Electron one suffixes its title with `· electron` so the
windows are tellable apart. `pnpm dev:electron` opens a Chrome DevTools Protocol port on **9333**
(not 9222 — that belongs to the shared aiui session browser), so the window can be driven and
inspected like any other Chromium.

The first `pnpm dev:electron` pauses to download Electron's ~200 MB platform binary. That is
lazy — electron@43 publishes no install script — so it happens on first run rather than at
`pnpm install`.

| | browser | Electron |
| --- | --- | --- |
| config | `vite.config.ts` | `vite.electron.config.ts` |
| shared | `vite.config.base.ts` | `vite.config.base.ts` |
| shell | `pnpm dev` | `electron/dev.mjs` → `electron/main.mjs` |

The renderer is identical in both — same bundle, same HMR, same DuckDB-WASM in-tab, same
`SharedArrayBuffer`-free `eh` bundle. Where it needs to know which shell it is in (today: the
title suffix, and nothing else) it asks at runtime, via [`src/host.ts`](./src/host.ts), rather
than through a build flag. Verified by measurement: with both servers up, the two render the same
52,516 characters of visible text, the same 62,290 SVG marks and the same 13 cells.

`electron/` is deliberately in-package for now. It moves to a shared package once the shape has
earned it.

## Open it in the shared browser

```sh
./aiui open http://localhost:5173   # from the repo root
```

Activate the intent client (**⌘B**) and describe what you want. See
[docs/guide/getting-started.md](../../docs/guide/getting-started.md).
