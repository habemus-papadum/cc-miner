# Deployment: where this stands, and what is next

Written 2026-07-29 as a handoff; §1 and §2 updated 2026-07-30 when signing and notarization
landed. The next session should start here.

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
| data | none, by construction. The corpus lives in `~/.cache/cc-miner`, outside the repo *and* outside the build; `pnpm -C cc-assay mine` makes your own |

**Measured, end to end:** the packaged macOS app boots and answers in both data modes — local
(duckdb-wasm in the renderer) and host (a native DuckDB sidecar the app spawns itself). Identical
numbers in a browser tab, an Electron dev window, and a `.dmg`-installed bundle. The `.dmg`/`.zip`
build, `latest-mac.yml`, and `electron-updater` detection all work. Signing and notarization are
done — see §2.

Sizes, and they are **constant** now whatever the size of your history: Electron 273 MB,
`app.asar` 89.6 MB (`dist/` is 76 MB of it, almost all duckdb-wasm), `libduckdb.dylib` 112 MB, `.dmg` ~155 MB.

They used to vary, because the corpus was compiled into the bundle — `app.asar` measured 89.6 MB
with no data and 128.5 MB with a real corpus, within ~11 MB of the 140 MB budget in `pack.mjs`.
Worse than the size: the `.dmg` carried the builder's own transcripts, 121 session replay files
with conversation bodies among them. `src/data` was gitignored, which protected the repository and
did nothing for the artifact. The renderer now fetches shards from `/__corpus` at run time, so a
build never sees the data — app README, "The corpus is never bundled".

## 2. Signing, notarization and release — **done, measured 2026-07-30**

A locally built `.dmg` and `.zip` are now signed, notarized, and stapled, and Gatekeeper accepts
both. This section used to say a `Developer ID Application` certificate was the only thing missing;
it exists now, on team **`QR7G4C9JWN`** (not `WBSD7374P8`, which is the `Apple Development` team and
is still the one `pack.mjs` refuses to sign with).

What was verified, on the artifacts themselves rather than from build logs:

| | |
| --- | --- |
| `codesign --verify --deep --strict` | valid, satisfies its Designated Requirement |
| chain | Developer ID Application → Developer ID CA → Apple Root CA |
| hardened runtime | `flags=0x10000(runtime)`, all five entitlements embedded |
| `libduckdb.dylib`, `duckdb.node` | re-signed under our Team ID — previously only inferred |
| `.dmg` and `.zip` | `accepted / source=Notarized Developer ID` |
| app **mounted from the dmg**, app **extracted from the zip** | both accepted |

Two things that only appeared by checking the result, both now handled in the repo:

- **The dmg is notarized separately, by `pack.mjs`, after electron-builder finishes.** electron-
  builder staples the `.app` and *then* wraps it, so the zip is correct as built and the dmg gets
  no ticket of its own. `stapleDmgs()` submits, staples, and re-validates.
- **`dmg.sign: true` is required.** With a ticket but no signature, Apple's documented check for a
  downloaded disk image — `spctl -a -t open --context context:primary-signature` — answers
  `rejected: no usable signature`, even though the app inside is accepted.

And one consequence worth not rediscovering: **stapling appends ~2 KB to the dmg**, which
invalidates any checksum recorded before it. Hence `dmg.writeUpdateInfo: false` — the dmg is
deliberately absent from `latest-mac.yml`. Nothing is lost, because electron-updater downloads what
`path:` names, which is the zip.

### 2.1 Reproducing it (needs the Apple account)

1. **The certificate** — Xcode → *Settings → Accounts → Manage Certificates → + → Developer ID
   Application*. Requires Account Holder or Admin; a free personal team can only issue
   `Apple Development`. Verify with:
   ```sh
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```
   Note that a machine with no distribution certificate also reports two `Developer ID` hits —
   those are Apple's *intermediate CAs*, which ship on every Mac. Grep for the full
   `Developer ID Application:` prefix, not `Developer ID`.

2. **An App Store Connect API key**, for notarization. appstoreconnect.apple.com → *Users and
   Access → Integrations → App Store Connect API → +*. Role **Developer** is enough. Download the
   `.p8` **once** — it cannot be re-downloaded. Keep the *Issuer ID* and *Key ID*.

   Prefer the API key over an app-specific password: no 2FA prompt, so it works unattended in CI.

3. **Locally.** Keep the key outside the repo — `~/.config/cc-miner/`, mode 600 — and source the
   three variables rather than exporting them into your shell profile:
   ```sh
   set -a; . ~/.config/cc-miner/signing.env; set +a
   pnpm -C pdum-cc-miner pack:mac
   ```
   `signing.env` holds only a path and two identifiers; the `.p8` is the sole secret.

   Validate credentials *before* a build — it costs seconds, where a bad trio otherwise fails at
   the very end of one:
   ```sh
   xcrun notarytool history --key <p8> --key-id <id> --issuer <issuer>
   ```

   `pack.mjs` prints which mode it chose before building — read that line rather than assuming.

   **Unset any stray `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` first.** electron-builder checks
   those *before* the API key and throws if either is set without the other, so a leftover in a
   shell profile hijacks notarization and hard-fails.

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

- **~~A real release has never been published~~ — DONE. `v0.1.0` shipped from CI, 2026-07-30.**
  Run 30559678800: dmg, zip, AppImage, deb and both `latest-*.yml` on the Releases tab.

  Verified by downloading the **published** dmg rather than trusting the build log: the ticket
  staples and validates offline, Gatekeeper says `accepted / source=Notarized Developer ID`, and
  the app dragged out of it is accepted with `flags=0x10000(runtime)` and the full Apple chain.
  `latest-mac.yml` names the zip only — the dmg appears zero times, as intended.

  The matrix race resolved as designed: linux published first (3 artifacts), mac hit the
  `already exists` branch and uploaded its 4 alongside.
- **~~The sidecar under notarization~~ — RESOLVED, measured 2026-07-30.** `pnpm smoke` passes on a signed, notarized, hardened-runtime bundle: local **and** host both render 69,915 marks over 37 charts (34,439 turns, 108 sessions). `utilityProcess` spawns, `libduckdb.dylib` loads, and the runtime-downloaded `quack.duckdb_extension` dlopens — the exact thing §2.2 exists to permit. Both modes read `~/.cache/cc-miner`, which is why the numbers match.
  §2.2 is why this needed checking at all: hardened runtime breaks host mode *only*, so a
  launch-only test cannot see it.

  Two false alarms on the way, both worth not repeating. The Electron shell kept a **third**
  corpus default (`<userData>/corpus`) that no longer matched where the miner writes — a real bug,
  found because the smoke test stopped overriding `PDUM_CC_MINER_CORPUS` and finally exercised the
  path the shipped app takes. Then host mode reported `0 marks` once more and looked broken: it was
  the **first host-mode boot of a fresh bundle downloading DuckDB's extensions**, which outran the
  90 s settle window. Nothing was wrong. `smoke.mjs` now says "still LOADING when the window
  closed" instead of reporting a timeout as a hard failure.
- **Auto-update's install half.** Squirrel.Mac verifies the replacement's signature against the
  running app's, which is now satisfiable for the first time. Detection *is* measured (a 0.1.0
  build against a feed advertising 0.9.9 finds it and waits for consent, via
  `PDUM_CC_MINER_UPDATE_URL`); the install half needs two signed builds and a feed between them.
- **Linux BUILDS but has never been RUN.** AppImage and deb are produced by CI and published, and
  `@duckdb/node-bindings-linux-x64` resolves correctly on the ubuntu runner (the "not bundled"
  warning there lists every platform *except* linux-x64 — the inverse of what macOS reports). What
  nobody has done is launch either artifact. **Host mode on Linux is the real unknown**: it needs
  `libduckdb.so` to have been `asarUnpack`ed and the sidecar to spawn, and neither can be checked
  from macOS. `pnpm smoke` on a Linux box is the test.
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

Extraction is also gated on publishing: this repo consumes those packages from npm, so each one
has to be released before anything here can depend on it.

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
- The root `devDependencies` are a superset of what this repo uses, and worth pruning.
- `DuckDB` fetches its extensions from `extensions.duckdb.org` on first query — a third-party
  runtime dependency on the *first-query* path. Scoped as acceptable (an open connection is
  assumed), but it is why a CDN outage looks like a data bug.
