/**
 * upstream.mjs — develop against the aiui packages' SOURCE, then get back.
 *
 *   pnpm link:up                     link every @habemus-papadum dep to ../pdum_aiui
 *   pnpm link:up aiui-viz            just that one
 *   pnpm link:up --path ~/work/aiui  an upstream checkout somewhere else
 *   pnpm unlink:up                   back to the published npm versions
 *   pnpm upstream                     what is linked right now
 *   pnpm upstream:check               exit 1 if anything is linked (CI runs this)
 *
 * ── Why overrides rather than `pnpm link` ────────────────────────────────────
 * `pnpm link` rewrites the dependency in the consuming package.json. That works,
 * but it is per-manifest: if an aiui package ever depends on another one, the
 * npm copy keeps its npm dependency and you end up with TWO copies of the same
 * library in the tree. This repo already has scar tissue from exactly that class
 * of bug — two duckdb-wasm copies whose identical types would not unify.
 *
 * A `pnpm-workspace.yaml` override redirects EVERY resolution of a name, direct
 * or transitive, and lives in one file. So the diff is one place, and `git
 * status` cannot fail to show it.
 *
 * (Measured today: aiui-viz has no transitive dependents here, so the two
 * mechanisms are currently equivalent. Overrides is the one that stays correct
 * when that changes.)
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * A link is a LOCAL state, never a committed one. It points at a path that
 * exists on one machine. `pnpm upstream:check` runs in CI and fails the build if
 * an override survives into a commit, so the failure is a sentence rather than a
 * mysterious install error on someone else's clone.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WS = join(REPO, "pnpm-workspace.yaml");
const SCOPE = "@habemus-papadum/";

/** The fence the generated entries live between, so removal is exact. */
const BEGIN = "  # >>> linked to local source by scripts/upstream.mjs — DO NOT COMMIT";
const END = "  # <<< end linked overrides";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "status";
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const names = argv.slice(1).filter((a, i) => !a.startsWith("--") && argv[i] !== "--path");

/** Where the upstream checkout is. Side by side is the default because it is the layout we use. */
function upstreamRoot() {
  const given = flagValue("--path") ?? process.env.AIUI_UPSTREAM;
  const p = given
    ? resolve(given.startsWith("~") ? join(homedir(), given.slice(1)) : given)
    : resolve(REPO, "..", "pdum_aiui");
  if (!existsSync(join(p, "packages"))) {
    console.error(
      `no aiui checkout at ${p}\n` +
        `  expected a sibling: ${resolve(REPO, "..")}/pdum_aiui\n` +
        `  or pass one: pnpm link:up --path <dir>   (or set AIUI_UPSTREAM)`,
    );
    process.exit(1);
  }
  return p;
}

/** Every `@habemus-papadum/*` this repo consumes from npm, and where upstream keeps it. */
function linkable(up) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const manifests = execFileSync("git", ["ls-files", "*/package.json"], {
    cwd: REPO,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  for (const m of manifests) {
    const pkg = JSON.parse(readFileSync(join(REPO, m), "utf8"));
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const [dep, range] of Object.entries(pkg[section] ?? {})) {
        // A workspace sibling is already source; only npm-resolved deps are linkable.
        if (!dep.startsWith(SCOPE) || String(range).startsWith("workspace:")) continue;
        const dir = join(up, "packages", dep.slice(SCOPE.length));
        if (existsSync(join(dir, "package.json"))) out.set(dep, dir);
      }
    }
  }
  return out;
}

function readWs() {
  return readFileSync(WS, "utf8");
}

/** The names currently redirected at local source. */
function linked() {
  const s = readWs();
  const i = s.indexOf(BEGIN);
  if (i < 0) return [];
  const block = s.slice(i, s.indexOf(END));
  return [...block.matchAll(/^\s*['"]([^'"]+)['"]:\s*link:(.+)$/gm)].map((m) => [
    m[1],
    m[2].trim(),
  ]);
}

/** Replace the fenced block (or drop it when empty). */
function writeBlock(entries) {
  let s = readWs();
  const i = s.indexOf(BEGIN);
  if (i >= 0) {
    const j = s.indexOf(END);
    s = s.slice(0, i) + s.slice(j + END.length).replace(/^\n/, "");
  }
  if (entries.length) {
    const lines = entries.map(([n, p]) => `  '${n}': link:${p}`).join("\n");
    const block = `${BEGIN}\n${lines}\n${END}\n`;
    // Inside the existing `overrides:` block if there is one, so pnpm sees one map.
    const m = s.match(/^overrides:\n(?:[ \t].*\n|#.*\n)*/m);
    s = m
      ? s.slice(0, m.index + m[0].length) + block + s.slice(m.index + m[0].length)
      : `${s.replace(/\n*$/, "\n")}\noverrides:\n${block}`;
  }
  writeFileSync(WS, s);
}

/** Run a command for its exit code only. @returns {number} */
function spawnQuiet(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: REPO, stdio: "ignore" });
    return 0;
  } catch (e) {
    return typeof e?.status === "number" ? e.status : 1;
  }
}

function install() {
  console.log("");
  execFileSync("pnpm", ["install"], { cwd: REPO, stdio: "inherit" });
}

function showStatus() {
  const l = linked();
  if (!l.length) {
    console.log("  nothing linked — every @habemus-papadum dep comes from npm.");
    return;
  }
  console.log("  LINKED to local source (do not commit):");
  for (const [n, p] of l) console.log(`    ${n.padEnd(42)} → ${p}`);
  console.log("\n  back to npm: pnpm unlink:up");
}

switch (cmd) {
  case "link": {
    const up = upstreamRoot();
    const all = linkable(up);
    const want = names.length
      ? names.map((n) => (n.startsWith(SCOPE) ? n : SCOPE + n))
      : [...all.keys()];
    const unknown = want.filter((n) => !all.has(n));
    if (unknown.length) {
      console.error(`not linkable: ${unknown.join(", ")}`);
      console.error(`  available: ${[...all.keys()].map((n) => n.slice(SCOPE.length)).join(", ")}`);
      process.exit(1);
    }
    // Relative so the file reads the same on any machine using the sibling layout.
    const entries = [...new Map([...linked(), ...want.map((n) => [n, rel(all.get(n))])])];
    writeBlock(entries);
    console.log(`  linked ${want.length} package(s) against ${up}`);
    install();
    showStatus();
    break;
  }
  case "unlink": {
    const keep = names.length
      ? linked().filter(([n]) => !names.some((x) => n === x || n === SCOPE + x))
      : [];
    writeBlock(keep);
    console.log(keep.length ? `  ${keep.length} link(s) remain` : "  all links removed");
    install();
    showStatus();
    // `pnpm install` re-resolves floating ranges, so it can drift the lockfile in
    // ways that have nothing to do with linking. Said out loud, because an
    // unexplained lockfile diff after a round trip looks like the link leaked.
    if (!keep.length) {
      const dirty = spawnQuiet("git", ["diff", "--quiet", "--", "pnpm-lock.yaml"]) !== 0;
      if (dirty) {
        console.log(
          "\n  note: pnpm-lock.yaml still differs from HEAD. That is ordinary\n" +
            "  re-resolution of floating ranges, not a leftover link. Keep it, or:\n" +
            "    git checkout -- pnpm-lock.yaml",
        );
      }
    }
    break;
  }
  case "status":
    showStatus();
    break;
  case "check": {
    const l = linked();
    if (!l.length) {
      console.log("  ✓ no local links — the tree resolves from npm.");
      break;
    }
    console.error(
      "✖ pnpm-workspace.yaml redirects packages at local source:\n" +
        l.map(([n, p]) => `    ${n} → ${p}`).join("\n") +
        "\n\n  A link points at a path that exists on one machine, so it cannot be\n" +
        "  committed. Run `pnpm unlink:up` and commit the result.",
    );
    process.exit(1);
    break; // unreachable, but Biome cannot prove process.exit does not return
  }
  default:
    console.error(`unknown command "${cmd}" — use link | unlink | status | check`);
    process.exit(2);
}

/** @param {string} abs */
function rel(abs) {
  const r = relative(REPO, abs);
  return isAbsolute(r) || r.startsWith("..") ? r : `./${r}`;
}
