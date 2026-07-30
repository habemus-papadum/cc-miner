import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { corpusDir, stagingDir } from "./corpus-dir.ts";

describe("corpusDir", () => {
  it("defaults to ~/.cache/cc-miner", () => {
    expect(corpusDir({})).toBe(join(homedir(), ".cache", "cc-miner"));
  });

  it("honours XDG_CACHE_HOME", () => {
    expect(corpusDir({ XDG_CACHE_HOME: "/xdg" })).toBe(join("/xdg", "cc-miner"));
  });

  it("lets PDUM_CC_MINER_CORPUS win over XDG", () => {
    expect(corpusDir({ PDUM_CC_MINER_CORPUS: "/explicit", XDG_CACHE_HOME: "/xdg" })).toBe(
      "/explicit",
    );
  });

  it("ignores an empty or whitespace override rather than resolving to nothing", () => {
    // An unset variable and one set to "" arrive identically from a shell, and
    // returning "" here would send every consumer at the filesystem root.
    expect(corpusDir({ PDUM_CC_MINER_CORPUS: "  " })).toBe(join(homedir(), ".cache", "cc-miner"));
    expect(corpusDir({ XDG_CACHE_HOME: "" })).toBe(join(homedir(), ".cache", "cc-miner"));
  });
});

describe("stagingDir", () => {
  it("sits inside the corpus dir but cannot be mistaken for a grain", () => {
    const staging = stagingDir({ PDUM_CC_MINER_CORPUS: "/c" });
    expect(staging).toBe(join("/c", ".staging"));
    // The app globs `<grain>/username=*/...`; a dotted directory holding flat
    // parquet can never satisfy that, which is the point of separating them.
    expect(staging.startsWith("/c/")).toBe(true);
    expect(staging).not.toMatch(/username=/);
  });

  it("follows the override wherever it points", () => {
    expect(stagingDir({ XDG_CACHE_HOME: "/xdg" })).toBe(join("/xdg", "cc-miner", ".staging"));
  });
});
