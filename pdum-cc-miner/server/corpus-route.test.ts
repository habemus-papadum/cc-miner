/**
 * What `/__corpus` will and will not serve.
 *
 * This route reads out of the user's HOME directory and is reachable from any
 * page the dev server serves, so its containment is the whole contract. The
 * corpus moved there precisely because it is personal telemetry; a traversal
 * here would turn a privacy fix into a file-disclosure bug.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "cc-corpus-"));
process.env.PDUM_CC_MINER_CORPUS = root;

const { corpusFile, corpusDir } = await import("./host-runtime.mjs");

mkdirSync(join(root, "turns", "username=me", "host=abc"), { recursive: true });
writeFileSync(join(root, "turns", "username=me", "host=abc", "part0.parquet"), "PAR1");
writeFileSync(join(root, "manifest.json"), "{}");
mkdirSync(join(root, ".staging"), { recursive: true });
writeFileSync(join(root, ".staging", "turns.parquet"), "PAR1");
// A secret OUTSIDE the corpus, one level up — what a traversal would reach.
writeFileSync(resolve(root, "..", "cc-corpus-secret"), "private");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(resolve(root, "..", "cc-corpus-secret"), { force: true });
});

describe("corpusDir", () => {
  it("follows PDUM_CC_MINER_CORPUS", () => {
    expect(corpusDir()).toBe(root);
  });
});

describe("corpusFile serves the corpus", () => {
  it("resolves a Hive shard", () => {
    const f = corpusFile("turns/username=me/host=abc/part0.parquet");
    expect(f).toBe(join(root, "turns", "username=me", "host=abc", "part0.parquet"));
  });

  it("resolves the manifest beside it", () => {
    expect(corpusFile("manifest.json")).toBe(join(root, "manifest.json"));
  });
});

describe("corpusFile refuses everything else", () => {
  // Each of these must return null. A regression here discloses files from the
  // home directory of whoever is running the dev server.
  const refused: Array<[string, string]> = [
    ["empty path", ""],
    ["the corpus root itself", "."],
    ["parent traversal", "../cc-corpus-secret"],
    ["deep traversal", "../../../../etc/passwd"],
    ["traversal after a valid prefix", "turns/../../cc-corpus-secret"],
    ["absolute path", "/etc/passwd"],
    ["the flat staging intermediate", ".staging/turns.parquet"],
    ["staging itself", ".staging"],
  ];

  for (const [label, path] of refused) {
    it(`refuses ${label}: ${JSON.stringify(path)}`, () => {
      expect(corpusFile(path)).toBeNull();
    });
  }

  it("refuses a traversal that arrived percent-encoded once decoded", () => {
    // The route decodes before calling this, so the decoded form is what must
    // be refused — asserted here so the decode order stays deliberate.
    expect(corpusFile(decodeURIComponent("..%2Fcc-corpus-secret"))).toBeNull();
  });
});
