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
 *   local  duckdb-wasm in the renderer, over the Parquet shipped in dist/
 *   host   the native DuckDB sidecar, spawned by the app, over src/data
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
      // src/data IS a Hive corpus, so it stands in for a user's exported one and
      // the sidecar has something real to serve. No fixture to build or carry.
      PDUM_CC_MINER_CORPUS: resolve(APP_ROOT, "src/data"),
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

    for (const mode of ["local", "host"]) {
      await evaluate(page, `location.href = 'app://pdum-cc-miner/?source=${mode}'; 1`);
      await new Promise((r) => setTimeout(r, 1500));
      // The navigation replaced the execution context, so re-resolve the target.
      const fresh = await waitForPage(CDP_PORT, 30_000);
      const fp = await evaluate(fresh, FINGERPRINT);
      const ok = fp.marks >= MIN_MARKS && fp.svgs >= MIN_SVGS;
      console.log(
        `  ${ok ? "✓" : "✗"} ${mode.padEnd(5)} ${String(fp.marks).padStart(6)} marks, ` +
          `${fp.svgs} charts, ${fp.turns} turns, ${fp.sessions} sessions`,
      );
      if (!ok) {
        failures.push(
          `${mode}: ${fp.marks} marks over ${fp.svgs} charts ` +
            `(wanted ≥${MIN_MARKS} over ≥${MIN_SVGS})${fp.error ? `\n    ${fp.error}` : ""}`,
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
  console.log("\n  smoke passed — the packaged app boots and both data modes answer.");
  process.exit(0);
}

main();
