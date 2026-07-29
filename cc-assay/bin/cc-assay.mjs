#!/usr/bin/env node
// Thin shim so the bin works without a build step: run the TS entry via tsx.
import { spawnSync } from "node:child_process";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const r = spawnSync(
  "npx",
  ["tsx", path.join(here, "..", "src", "cli.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);
