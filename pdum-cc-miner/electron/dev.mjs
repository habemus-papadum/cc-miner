/**
 * electron/dev.mjs — `pnpm dev:electron`.
 *
 * Starts the Vite dev server from vite.electron.config.ts, then opens an
 * Electron window onto it. Two processes, one lifetime: close the window and
 * the server goes down; Ctrl-C the terminal and both do.
 *
 * The server is started through Vite's NODE API rather than by shelling out to
 * `vite`, for one reason: `server.resolvedUrls` tells us the port Vite ACTUALLY
 * bound. Spawning the CLI would leave us either guessing the port (wrong the
 * moment 5179 is busy and Vite walks forward) or scraping stdout and racing the
 * window against the listen. Here the URL is a return value.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const mainEntry = fileURLToPath(new URL("./main.mjs", import.meta.url));

// `require("electron")` from a plain Node process resolves to the path of the
// Electron BINARY, not the module — that is the npm package's documented shape.
const electronBin = createRequire(import.meta.url)("electron");

const server = await createServer({
  root: appRoot,
  configFile: fileURLToPath(new URL("../vite.electron.config.ts", import.meta.url)),
});
await server.listen();
server.printUrls();

const url = server.resolvedUrls?.local?.[0];
if (!url) {
  await server.close();
  throw new Error("vite reported no local URL to point the window at");
}

const child = spawn(electronBin, [mainEntry], {
  stdio: "inherit",
  env: {
    ...process.env,
    PDUM_CC_MINER_URL: url,
    // Not 9222 — see the note in main.mjs. Override or blank it out to disable.
    PDUM_CC_MINER_CDP_PORT: process.env.PDUM_CC_MINER_CDP_PORT ?? "9333",
  },
});

console.log(`\n  ▸ electron window on ${url}\n`);

let closing = false;
/** @param {number} code */
async function shutdown(code) {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(code);
}

child.on("exit", (code) => shutdown(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill();
    shutdown(0);
  });
}
