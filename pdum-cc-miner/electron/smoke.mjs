/**
 * smoke.mjs — launch the PACKAGED app and prove it actually works.
 *
 *   node electron/smoke.mjs            # finds the build under release/
 *   node electron/smoke.mjs <binary>
 *
 * "It builds" and "it boots" are very different claims, and only the second one
 * is worth CI time. This drives the real bundle over CDP and asserts on what it
 * renders, in BOTH data modes:
 *
 *   local  duckdb-wasm in the renderer, over corpus bytes served by the app
 *   host   the native DuckDB sidecar, spawned by the app, over the same corpus
 *
 * Both now read ~/.cache/cc-miner — the corpus is no longer shipped inside the
 * bundle, so this needs one mined on the machine running it. `pnpm -C cc-assay
 * mine` produces it; without one, both modes fail with instructions rather than
 * rendering an empty page.
 *
 * The second is the one that earns its keep on Linux. Local mode exercises no
 * native code at all, so an app whose `duckdb.node` failed to unpack — or whose
 * libduckdb cannot be dlopen'd — still renders every chart and looks healthy.
 * Host mode is the only path that touches the platform binary.
 *
 * No fixtures are needed for either: `src/data` is already a Hive corpus, so it
 * can play the part of a user's exported one.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");
const CDP_PORT = Number(process.env.PDUM_CC_MINER_CDP_PORT ?? 9422);

/** Where each platform's packaged binary lands. */
const CANDIDATES = [
  "release/mac-arm64/pdum-cc-miner.app/Contents/MacOS/pdum-cc-miner",
  "release/mac/pdum-cc-miner.app/Contents/MacOS/pdum-cc-miner",
  "release/linux-unpacked/pdum-cc-miner",
  "release/linux-arm64-unpacked/pdum-cc-miner",
];

function findBinary() {
  const given = process.argv[2];
  if (given) return resolve(given);
  for (const c of CANDIDATES) {
    const p = resolve(APP_ROOT, c);
    if (existsSync(p)) return p;
  }
  console.error(
    `no packaged binary found. Looked for:\n${CANDIDATES.map((c) => `  ${c}`).join("\n")}\n` +
      `Build one first: pnpm pack:dir`,
  );
  process.exit(2);
}

/**
 * Poll the CDP endpoint until a page target appears, or give up.
 *
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<{webSocketDebuggerUrl: string, url: string, type: string}>}
 */
async function waitForPage(port, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const targets = /** @type {{webSocketDebuggerUrl: string, url: string, type: string}[]} */ (
        await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      );
      const page = targets.find((t) => t.type === "page" && t.url.startsWith("app://"));
      if (page) return page;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no app:// page target on CDP :${port} within ${timeoutMs / 1000}s`);
}

/**
 * Evaluate an expression in a page target and return its value.
 *
 * @param {{webSocketDebuggerUrl: string}} page
 * @param {string} expression
 * @returns {Promise<any>}
 */
async function evaluate(page, expression) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error("CDP socket refused")));
  });
  /** @type {any} */
  const out = await new Promise((res, rej) => {
    ws.addEventListener("message", (/** @type {MessageEvent} */ ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    });
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true, timeout: 120_000 },
      }),
    );
  });
  ws.close();
  if (out.exceptionDetails) {
    throw new Error(`page threw: ${JSON.stringify(out.exceptionDetails.exception ?? {})}`);
  }
  return out.result.value;
}

/**
 * Wait for the charts to stop changing, then describe what is on screen.
 *
 * Settling on a STABLE mark count rather than a fixed sleep: the two modes take
 * different times to first paint, and a sleep long enough for the slower one
 * wastes it on every run of the faster.
 */
const FINGERPRINT = `(async () => {
  const marks = () => document.querySelectorAll('svg g[aria-label] > *').length;
  const t0 = Date.now(); let last = -1, stable = 0;
  while (Date.now() - t0 < 90000) {
    await new Promise(r => setTimeout(r, 400));
    const m = marks();
    stable = (m === last && m > 0) ? stable + 1 : 0;
    last = m;
    if (stable >= 4) break;
  }
  const num = (l) => [...document.querySelectorAll('*')]
    .find(e => e.children.length === 0 && e.textContent.trim() === l)
    ?.previousElementSibling?.textContent?.trim() ?? null;
  return {
    marks: last,
    svgs: document.querySelectorAll('svg').length,
    turns: num('turns'),
    sessions: num('sessions'),
    // Still on the spinner? Then this is SLOW, not broken — and the two look
    // identical from a mark count alone. Host mode reported 0 marks once on a
    // freshly packaged bundle and passed unchanged on the next run, so the
    // build was fine and the report was not. The cause was never established:
    // the obvious suspect, DuckDB fetching its extensions on first use, is
    // MEASURED at 1.8 s / 62 MB on a fast link — nowhere near this window,
    // though minutes on a slow one. Report the state, do not guess the reason.
    loading: !!document.querySelector('.cco-loading'),
    loadingLabel: document.querySelector('.cco-loading-label')?.textContent ?? null,
    // Which source actually answered, and what the build offers. A packaged app
    // is a PRODUCTION build, so it must have host only — this is how the test
    // knows it is checking that rather than being quietly redirected to it.
    sourceLabel: document.querySelector('.cco-source-label')?.textContent?.trim() ?? null,
    switchable: document.querySelectorAll('.cco-source-btn').length,
    // Everything the app is prepared to say went wrong, so a failure reports the
    // app's own words rather than only "0 marks".
    error: (document.body.innerText.match(/The loader reported:[\\s\\S]{0,400}/) || [''])[0],
  };
})()`;

/** A mode passes only if it drew real marks across the real number of charts. */
const MIN_MARKS = 1000;
const MIN_SVGS = 10;

async function main() {
  const binary = findBinary();
  console.log(`  binary: ${binary}`);

  const child = spawn(binary, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PDUM_CC_MINER_CDP_PORT: String(CDP_PORT),
      // No PDUM_CC_MINER_CORPUS override: the point is to exercise the DEFAULT
      // path the shipped app takes, which is ~/.cache/cc-miner. Pointing this at
      // a fixture would test a configuration no user runs — and the last version
      // of this file pointed it at `src/data`, a flat corpus the app cannot read
      // at all, which is why both modes drew zero marks and reported grains
      // named `turns.parquet`.
    },
  });
  let childLog = "";
  child.stdout.on("data", (/** @type {Buffer} */ d) => {
    childLog += d;
    process.stdout.write(`  [app] ${d}`);
  });
  child.stderr.on("data", (/** @type {Buffer} */ d) => {
    childLog += d;
  });
  const exited = new Promise((res) => child.on("exit", (code) => res(code)));

  /** @type {string[]} */
  const failures = [];
  try {
    const page = await Promise.race([
      waitForPage(CDP_PORT),
      exited.then((c) => {
        throw new Error(`the app exited (code ${c}) before opening a window:\n${childLog}`);
      }),
    ]);

    // A packaged app is a PRODUCTION build, so `local` does not exist in it —
    // see `availableModes` in src/model/source-mode.ts. Both navigations below
    // must therefore end in HOST, and the second one is the interesting case:
    // it asks for a mode this build does not have, which must resolve to host
    // rather than error or hang.
    //
    // This loop used to be `for (const mode of ["local", "host"])` and asserted
    // marks in each. Left alone, it would now pass by testing host twice and
    // reporting the first pass as "local" — a check that had silently stopped
    // checking, which is the failure this file's own history warns about. So the
    // resolved source is asserted, not assumed.
    for (const { asked, why } of [
      { asked: "host", why: "the only mode a shipped build has" },
      { asked: "local", why: "must fall through to host, not error" },
    ]) {
      await evaluate(page, `location.href = 'app://pdum-cc-miner/?source=${asked}'; 1`);
      await new Promise((r) => setTimeout(r, 1500));
      // The navigation replaced the execution context, so re-resolve the target.
      const fresh = await waitForPage(CDP_PORT, 30_000);
      const fp = await evaluate(fresh, FINGERPRINT);
      const servedByHost = (fp.sourceLabel ?? "").startsWith("host");
      const ok =
        fp.marks >= MIN_MARKS && fp.svgs >= MIN_SVGS && servedByHost && fp.switchable === 0;
      console.log(
        `  ${ok ? "✓" : "✗"} ?source=${asked.padEnd(5)} → ${String(fp.sourceLabel).slice(0, 34).padEnd(34)} ` +
          `${String(fp.marks).padStart(6)} marks, ${fp.svgs} charts, ${fp.turns} turns`,
      );
      const mode = `?source=${asked} (${why})`;
      if (!servedByHost) {
        failures.push(`${mode}: served by "${fp.sourceLabel}" — a shipped build must use host`);
      }
      if (fp.switchable !== 0) {
        failures.push(
          `${mode}: ${fp.switchable} source buttons rendered; a production build offers one mode ` +
            `and must not present a switch`,
        );
      }
      // Only the rendering complaint here — the source and switcher checks
      // above report themselves, so a single run does not say the same thing
      // three times.
      if (fp.marks < MIN_MARKS || fp.svgs < MIN_SVGS) {
        failures.push(
          `${mode}: ${fp.marks} marks over ${fp.svgs} charts ` +
            `(wanted ≥${MIN_MARKS} over ≥${MIN_SVGS})` +
            // Say WHICH failure this is. "0 marks" with the spinner still up is
            // a timeout, not a broken build, and reporting them identically
            // sent one debugging session after a bug that did not exist.
            (fp.loading
              ? `\n    still LOADING when the window closed${fp.loadingLabel ? ` ("${fp.loadingLabel}")` : ""} —` +
                `\n    slow, not necessarily broken. Re-run before digging: this has resolved on a` +
                `\n    second run before. On a slow link, suspect DuckDB's first-use extension` +
                `\n    fetch (62 MB; 1.8 s here, minutes on a bad connection).`
              : "") +
            (fp.error ? `\n    ${fp.error}` : ""),
        );
      }
    }
  } catch (e) {
    failures.push(String(e instanceof Error ? e.message : e));
  } finally {
    child.kill();
  }

  if (failures.length) {
    console.error(`\n  SMOKE FAILED\n${failures.map((f) => `    ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log(
    "\n  smoke passed — the packaged app boots, host mode answers, and `local` is" +
      "\n  absent from the shipped build rather than merely unused.",
  );
  process.exit(0);
}

main();
