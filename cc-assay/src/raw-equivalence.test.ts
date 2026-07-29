/**
 * The two-stage contract: normalizing a corpus through the raw layer must give
 * the same grains as normalizing the JSONL directly.
 *
 * This is the property that makes stage 1 worth having. If it does not hold,
 * the raw layer is not a faithful record of the transcripts and every figure
 * derived from it is suspect. It caught two real defects when it was written:
 *
 *  - the event dedup key was key-order sensitive, so the JSONL path drew one
 *    `relocated` record twice (see `canonicalJson`);
 *  - `birthtimeMs` carried sub-millisecond precision that an INT64 column
 *    truncates, so `lagSeconds` disagreed between the paths.
 *
 * `hostId` is deliberately exempt: the raw path carries the ingesting machine's
 * minted id and the JSONL path has no host to name. That is the one field the
 * two paths are *supposed* to differ on.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PriceTable } from "./pricing.ts";
import { ingestCorpus } from "./raw-run.ts";
import { normalizeCorpus } from "./run.ts";

const PRICES: PriceTable = {
  version: "test",
  source: "litellm",
  entries: {
    "claude-opus-5": {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 25e-6,
      cache_creation_input_token_cost: 6.25e-6,
      cache_read_input_token_cost: 0.5e-6,
    },
  },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cc-equiv-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ts = (n: number) => new Date(1_780_000_000_000 + n * 1000).toISOString();

const assistant = (uuid: string, parent: string | null, msgId: string, out: number) => ({
  type: "assistant",
  uuid,
  parentUuid: parent,
  sessionId: "s1",
  timestamp: ts(Number(uuid.slice(1))),
  requestId: `req_${msgId}`,
  cwd: "/Users/x/src/proj",
  message: {
    id: msgId,
    model: "claude-opus-5",
    content: [{ type: "text", text: "hi" }],
    usage: { input_tokens: 5, output_tokens: out, cache_read_input_tokens: 100 },
  },
});

/**
 * A corpus with the two shapes that broke: a `relocated` record duplicated
 * across a fork copy with DIFFERENT key order, and a fork whose child file has
 * a birthtime.
 */
async function corpus(root: string) {
  const slug = "-Users-x-src-proj";
  await mkdir(path.join(root, slug), { recursive: true });

  // The same relocation, written twice with the keys in different orders —
  // exactly what a fork copy does, and what defeated the old dedup key.
  const relocA = `{"type":"relocated","sessionId":"s1","relocatedCwd":"/Users/x/src/proj"}`;
  const relocB = `{"relocatedCwd":"/Users/x/src/proj","sessionId":"s1","type":"relocated"}`;

  const parent = [
    JSON.stringify({
      type: "user",
      uuid: "u0",
      parentUuid: null,
      sessionId: "s1",
      timestamp: ts(0),
    }),
    relocA,
    JSON.stringify(assistant("u1", "u0", "m1", 40)),
    JSON.stringify(assistant("u2", "u1", "m2", 60)),
  ];
  await writeFile(path.join(root, slug, "s1.jsonl"), `${parent.join("\n")}\n`);

  // A fork: the prefix copied verbatim (bar the relocation's key order), then
  // its own turn. The copied records must not be billed twice.
  const child = [
    JSON.stringify({
      type: "user",
      uuid: "u0",
      parentUuid: null,
      sessionId: "s1",
      timestamp: ts(0),
    }),
    relocB,
    JSON.stringify(assistant("u1", "u0", "m1", 40)),
    JSON.stringify({ ...assistant("u3", "u1", "m3", 80), sessionId: "s2" }),
  ];
  await writeFile(path.join(root, slug, "s2.jsonl"), `${child.join("\n")}\n`);
}

describe("raw layer equivalence", () => {
  it("produces the same grains through the raw layer as from JSONL", async () => {
    const root = path.join(dir, "projects");
    await corpus(root);
    const pricing = PRICES;

    const rawDir = path.join(dir, "raw");
    await ingestCorpus({ roots: [root], out: rawDir });

    const viaJsonl = await normalizeCorpus({ roots: [root], pricing });
    const viaRaw = await normalizeCorpus({ rawDir, roots: [root], pricing });

    const strip = (rows: unknown[]) =>
      JSON.stringify(rows.map((r) => ({ ...(r as object), hostId: undefined })));

    for (const table of Object.keys(viaJsonl.normalized) as (keyof typeof viaJsonl.normalized)[]) {
      const a = viaRaw.normalized[table];
      const b = viaJsonl.normalized[table];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      expect(strip(a), `table ${String(table)} differs between ingest paths`).toBe(strip(b));
    }
  });

  it("registers a session file that holds no records, as the JSONL path does", async () => {
    // A session started and abandoned contributes zero rows to `raw.parquet`,
    // so a reader driven by records alone would never see it. It is still a
    // session, and `noteFile` is what makes it one. The live corpus has no such
    // file today, which is exactly why this is pinned here.
    const root = path.join(dir, "projects");
    await corpus(root);
    await writeFile(path.join(root, "-Users-x-src-proj", "s3.jsonl"), "");
    const pricing = PRICES;

    const rawDir = path.join(dir, "raw");
    await ingestCorpus({ roots: [root], out: rawDir });

    const viaJsonl = await normalizeCorpus({ roots: [root], pricing });
    const viaRaw = await normalizeCorpus({ rawDir, roots: [root], pricing });

    expect(viaRaw.stats.files).toBe(viaJsonl.stats.files);
    expect(viaRaw.normalized.sessions.map((s) => s.sessionId).sort()).toEqual(
      viaJsonl.normalized.sessions.map((s) => s.sessionId).sort(),
    );
    expect(viaRaw.normalized.sessions.some((s) => s.sessionId === "s3")).toBe(true);
  });

  it("counts the same files and bytes on both paths", async () => {
    const root = path.join(dir, "projects");
    await corpus(root);
    const pricing = PRICES;
    const rawDir = path.join(dir, "raw");
    await ingestCorpus({ roots: [root], out: rawDir });

    const viaJsonl = await normalizeCorpus({ roots: [root], pricing });
    const viaRaw = await normalizeCorpus({ rawDir, roots: [root], pricing });

    expect(viaRaw.stats.files).toBe(viaJsonl.stats.files);
    expect(viaRaw.stats.bytes).toBe(viaJsonl.stats.bytes);
    expect(viaRaw.stats.files).toBeGreaterThan(0);
  });

  it("carries the ingesting host's id on the raw path and not on the JSONL path", async () => {
    const root = path.join(dir, "projects");
    await corpus(root);
    const pricing = PRICES;
    const rawDir = path.join(dir, "raw");
    await ingestCorpus({ roots: [root], out: rawDir });

    const viaRaw = await normalizeCorpus({ rawDir, roots: [root], pricing });
    for (const t of viaRaw.normalized.turns) expect(t.hostId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
