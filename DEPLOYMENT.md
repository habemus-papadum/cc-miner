# Deployment: where this stands, and what is next

Written 2026-07-29 as a handoff. The next session should start here.

Everything below marked **measured** was verified by running it, and the numbers are real. Do not
re-derive those — the interesting ones cost hours to find. Everything marked **unverified** has
never been executed; treat it as a plan, not a fact.

---

## 1. State

| | |
| --- | --- |
| repo | `habemus-papadum/cc-miner`, public, CI green |
| packages | `pdum-cc-miner/` (the app), `cc-assay/` (the miner) |
| upstream | `@habemus-papadum/*` from npm at `^0.12.0` — **measured**: installs, typechecks, tests, and the renderer builds against the published artifacts |
| data | none, by design. `src/data` is gitignored; run `cc-assay` to make your own |

**Measured, end to end:** the packaged macOS app boots and answers in both data modes — local
(duckdb-wasm in the renderer) and host (a native DuckDB sidecar the app spawns itself). Identical
numbers in a browser tab, an Electron dev window, and a `.dmg`-installed bundle. The `.dmg`/`.zip`
build, `latest-mac.yml`, and `electron-updater` detection all work.

Sizes: `.app` 495 MB installed (Electron 273, `dist/` 108, `libduckdb.dylib` 112), `.dmg` 192 MB.

## 2. The only thing standing between this and a shippable macOS build

**A `Developer ID Application` certificate.** This machine has only `Apple Development`
(team `WBSD7374P8`), which `electron/pack.mjs` deliberately **refuses** to sign with — that
certificate produces something that looks signed, passes `codesign --verify`, runs where it was
built, and is rejected by `notarytool` and by Gatekeeper on every other Mac. Unsigned and honest
beats signed and untrue.

### 2.1 What to create (needs the Apple account; ~15 minutes)

1. **The certificate.** Xcode → *Settings → Accounts → Manage Certificates → + → Developer ID
   Application*. Requires the Account Holder or Admin role on the team; a free personal team can
   only issue `Apple Development`. Verify with:
   ```sh
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```
   With it present, `pnpm -C pdum-cc-miner pack:mac` signs automatically — `gatherSigning()` looks
   for that exact string.

2. **An App Store Connect API key**, for notarization. appstoreconnect.apple.com → *Users and
   Access → Integrations → App Store Connect API → +*. Role **Developer** is enough. Download the
   `.p8` **once** — it cannot be re-downloaded. Keep the *Issuer ID* and *Key ID*.

   Prefer the API key over an app-specific password: no 2FA prompt, so it works unattended in CI.

3. **Locally**, to notarize from your machine:
   ```sh
   export APPLE_API_KEY=~/private_keys/AuthKey_XXXXXXXX.p8
   export APPLE_API_KEY_ID=XXXXXXXX
   export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   pnpm -C pdum-cc-miner pack:mac
   ```
   `pack.mjs` prints which mode it chose before building — read that line rather than assuming.

4. **In CI**, as repo secrets (Settings → Secrets and variables → Actions):

   | secret | what it is |
   | --- | --- |
   | `CSC_LINK` | the Developer ID cert as a base64 `.p12` — `security export`, then `base64 -i cert.p12` |
   | `CSC_KEY_PASSWORD` | the password you set exporting it |
   | `APPLE_API_KEY_B64` | `base64 -i AuthKey_XXXXXXXX.p8` — the workflow writes it to a file, since electron-builder wants a path |
   | `APPLE_API_KEY_ID` | Key ID |
   | `APPLE_API_ISSUER` | Issuer ID |

   Then `gh workflow run release.yml -f version=0.1.0 -f dry_run=false`.

### 2.2 The entitlement that is load-bearing — measured, do not remove

Hardened runtime (mandatory for notarization) enables **library validation**. A controlled pair of
builds, identical but for one key:

| `com.apple.security.cs.disable-library-validation` | app launches | host mode |
| --- | --- | --- |
| absent | yes — all 33 charts render | **fails** |
| present | yes | works |

```
dlopen(~/.duckdb/extensions/v1.5.5/osx_arm64/quack.duckdb_extension, 0x0006):
  code signature not valid for use in process
```

Note *which* file. **Not** `libduckdb.dylib` — electron-builder re-signs everything inside the
bundle with our identity, so the bundled 112 MB engine passes. The blocker is the DuckDB extension
downloaded **at runtime**, which can never be re-signed by us because it does not exist at
packaging time. Bundling the extensions instead does not help: DuckDB verifies its *own* signature
over the file, and `codesign` appends to the Mach-O.

Note also the failure *shape* — the app launches, local mode renders everything, and only host mode
dies. Signed, hardened, and broken in exactly the half a smoke test would not cover.

`build/entitlements.mac.plist` justifies each of its four holes. Read it before editing it.

### 2.3 Unverified, and expected to bite first

- **Notarization has never run.** Stapling, the `zip`-vs-`dmg` ordering, and whether the sidecar's
  `utilityProcess` survives a notarized bundle are all untested.
- **Auto-update cannot work unsigned.** Squirrel.Mac verifies the replacement's signature against
  the running app's, so an unsigned build downloads and fails to install. Detection *is* measured
  (a 0.1.0 build against a feed advertising 0.9.9 finds it and waits for consent, via
  `PDUM_CC_MINER_UPDATE_URL`); the install half becomes testable only once signing works.
- **Linux has never been built.** AppImage + deb are configured and the DuckDB linux bindings exist
  on npm and in the lockfile, but no artifact has been produced. Needs a Linux runner.
- **x64 macOS** is not configured — arm64 only. The `@duckdb/node-bindings-darwin-x64` package
  exists, so it is a target-list change plus a build.

## 3. Then: extract the reusable infrastructure

The point of the exercise. Three packages, all of which currently exist as app-local files that
know nothing about cc-miner and should not live here.

| package | what moves | why it is reusable |
| --- | --- | --- |
| `aiui-electron` | `electron/app-scheme.mjs`, the dev/prod split in `main.mjs`, `pack.mjs`'s `extraMetadata` trick, `make-icon.mjs`, `updater.mjs` | none of it mentions cc-miner |
| `aiui-duckdb-host` | `server/duckdb-host.mjs`, `server/host-runtime.mjs`, `electron/duckdb-sidecar.mjs` | any DuckDB desktop app |
| `quackConnector` | `src/model/quack.ts` — ~10 lines | any Mosaic app with a remote DuckDB |

**Four designs worth carrying out intact, because each was arrived at by failing the other way:**

1. **The renderer is never told which shell it is in.** `src/host.ts` sniffs at runtime; there is no
   build flag. That is what keeps "the same app runs in a tab and a window" checkable.
2. **The origin tells the page where the data is; the page never derives it.** `quackUri` used to be
   `quack:${location.host}/quack`, which is right over http and becomes `quack:cc-miner/quack`
   under `app://` — a hostname DuckDB dials over TCP. It failed by *hanging*, with no request and no
   error. The lookup now states the endpoint.
3. **No IPC.** The sidecar starts on the first `/__duckdb-host` request, which the renderer only
   makes in host mode — so the lifetime is already right and there is no signal to invent.
4. **No fallback between data modes.** Asking for `host` with no host is an error, never a quiet
   downgrade. A stale local corpus standing in for the real one is invisible in the UI.

**The reusability test is a second consumer, not an assertion.** A trivial second app must run on
these three packages before extraction counts as done.

Extraction is also gated: they must be published before an evicted repo can depend on them, which
is what `pnpm evict:check` enforces upstream.

## 4. Working with upstream while doing this

Extraction means editing `pdum_aiui` and consuming it here, constantly. Three levers, smallest
first — see the README section and `scripts/upstream.mjs`:

```sh
pnpm link:up aiui-viz            # source, instant HMR, local only
pnpm unlink:up                   # back to npm
```
```sh
gh workflow run release.yml -f canary=true    # in pdum_aiui: X.Y.Z-canary.<sha>
```

`pnpm upstream:check` runs in CI and fails if a link is ever committed. The canary path is
**unverified** — nobody has dispatched it.

## 5. Loose ends

- `pdum-cc-miner`'s `electron/smoke.mjs` works but is **not** in CI: it needs a corpus, and this
  repo has none. Run it manually after `pack:dir`.
- Two size levers, measured and deliberately not taken: the unused 41 MB `mvp` duckdb-wasm bundle,
  and 28 MB of replay Parquet that only local mode reads.
- The root `devDependencies` were carried wholesale from `pdum_aiui` and are a superset worth
  pruning.
- `DuckDB` fetches its extensions from `extensions.duckdb.org` on first query — a third-party
  runtime dependency on the *first-query* path. Scoped as acceptable (an open connection is
  assumed), but it is why a CDN outage looks like a data bug.
