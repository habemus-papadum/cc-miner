/**
 * The raw layer's contract. Two properties matter and nothing else does:
 * every line comes back, and it comes back meaning the same thing.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parquetReadObjects } from "hyparquet";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHost } from "./host.ts";
import { classify, ingestRoot } from "./raw.ts";
import { rawColumns } from "./raw-parquet.ts";

/** Deep equality that ignores object key order — see `raw.ts` on losslessness. */
function normalize(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(normalize);
  const o = v as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, normalize(o[k])]),
  );
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cc-raw-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A tiny projects/ tree: one session, one subagent, one memory sidecar. */
async function fixture(root: string) {
  const slug = "-Users-x-src-proj";
  await mkdir(path.join(root, slug, "sess1", "subagents"), { recursive: true });
  await mkdir(path.join(root, slug, "memory"), { recursive: true });
  const rows = [
    { type: "assistant", uuid: "u1", message: { id: "m1", usage: { output_tokens: 7 } } },
    { type: "system", uuid: "u2", compactMetadata: { trigger: "auto", preTokens: 1000 } },
    // deliberately awkward: unicode, nesting, an empty array, a null
    {
      type: "user",
      uuid: "u3",
      text: "héllo — ✓",
      tags: [],
      parentUuid: null,
      deep: { a: { b: [1, 2, { c: true }] } },
    },
  ];
  await writeFile(
    path.join(root, slug, "sess1.jsonl"),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
  await writeFile(
    path.join(root, slug, "sess1", "subagents", "agent-a1.jsonl"),
    `${JSON.stringify({ type: "assistant", uuid: "u4", isSidechain: true })}\n`,
  );
  await writeFile(path.join(root, slug, "memory", "MEMORY.md"), "- a memory line\n");
  return { slug, rows };
}

describe("raw ingest", () => {
  it("captures every JSONL line, value-losslessly", async () => {
    const root = path.join(dir, "projects");
    const { rows } = await fixture(root);
    const host = await resolveHost(dir);
    const { raw, stats } = await ingestRoot(root, host);

    expect(stats.parseErrors).toBe(0);
    expect(stats.lines).toBe(4); // 3 session + 1 subagent
    expect(raw).toHaveLength(4);

    // Every original record survives, key order aside. Matched by uuid rather
    // than index: the walk yields subdirectories before the files beside them,
    // so row order follows the tree, not the fixture's declaration order.
    const byUuid = new Map(
      raw.map((r) => [(r.rec as Record<string, unknown> | null)?.uuid as string, r.rec]),
    );
    for (const original of rows) {
      expect(same(byUuid.get(original.uuid), original), `record ${original.uuid} changed`).toBe(
        true,
      );
    }
    // Including the awkward one: unicode, empty array, explicit null, nesting.
    const awkward = byUuid.get("u3") as Record<string, unknown>;
    expect(awkward.text).toBe("héllo — ✓");
    expect(awkward.tags).toEqual([]);
    expect(awkward.parentUuid).toBeNull();
    expect(same(awkward.deep, { a: { b: [1, 2, { c: true }] } })).toBe(true);
  });

  it("survives a Parquet round-trip with the same values", async () => {
    const root = path.join(dir, "projects");
    const { rows } = await fixture(root);
    const host = await resolveHost(dir);
    const { raw } = await ingestRoot(root, host);

    const { parquetWriteFile } = await import("hyparquet-writer");
    const file = path.join(dir, "raw.parquet");
    parquetWriteFile({ filename: file, columnData: rawColumns(raw) as never });

    const back = await parquetReadObjects({ file: (await readFile(file)).buffer as ArrayBuffer });
    expect(back).toHaveLength(raw.length);
    const byUuid = new Map(
      back.map((r) => [(r.rec as Record<string, unknown> | null)?.uuid as string, r.rec]),
    );
    for (const original of rows) {
      expect(
        same(byUuid.get(original.uuid), original),
        `record ${original.uuid} changed through parquet`,
      ).toBe(true);
    }
  });

  it("keeps the text of a line it cannot parse instead of dropping it", async () => {
    const root = path.join(dir, "projects");
    await mkdir(path.join(root, "-Users-x-src-proj"), { recursive: true });
    await writeFile(
      path.join(root, "-Users-x-src-proj", "s.jsonl"),
      `${JSON.stringify({ type: "user", uuid: "ok" })}\n{"truncated": \n`,
    );
    const host = await resolveHost(dir);
    const { raw, stats } = await ingestRoot(root, host);

    expect(stats.parseErrors).toBe(1);
    expect(raw).toHaveLength(2); // the bad line is kept, not skipped
    expect(raw[1].rec).toBeNull();
    expect(raw[1].rawText).toBe('{"truncated": ');
  });

  it("records the non-JSONL sidecars, with text where it is small", async () => {
    const root = path.join(dir, "projects");
    await fixture(root);
    const host = await resolveHost(dir);
    const { files } = await ingestRoot(root, host);

    const memory = files.find((f) => f.relPath.endsWith("MEMORY.md"));
    expect(memory, "the memory sidecar was not captured").toBeDefined();
    expect(memory?.text).toBe("- a memory line\n");
    expect(memory?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // JSONL files are listed too, so `files` is a complete picture of the tree.
    expect(files.filter((f) => f.relPath.endsWith(".jsonl"))).toHaveLength(2);
  });

  it("addresses every row by host, file and line", async () => {
    const root = path.join(dir, "projects");
    await fixture(root);
    const host = await resolveHost(dir);
    const { raw } = await ingestRoot(root, host);

    for (const r of raw) {
      expect(r.hostId).toBe(host.hostId);
      expect(r.relPath).not.toContain(dir); // relative, so it means the same on any machine
      expect(r.lineNo).toBeGreaterThan(0);
    }
    // The subagent row is classified and attributed to its session directory.
    const sub = raw.find((r) => r.fileKind === "subagent");
    expect(sub?.fileSessionId).toBe("sess1");
  });

  it("skips a file whose size and mtime are unchanged", async () => {
    const root = path.join(dir, "projects");
    await fixture(root);
    const host = await resolveHost(dir);
    const first = await ingestRoot(root, host);
    const known = new Map(
      first.files.map((f) => [f.relPath, { bytes: f.bytes, mtimeMs: f.mtimeMs }]),
    );
    const second = await ingestRoot(root, host, known);

    expect(first.raw.length).toBe(4);
    expect(second.raw).toHaveLength(0); // nothing re-read
    expect(second.files.length).toBe(first.files.length); // still a full picture
  });
});

describe("classify", () => {
  it("separates jsonl from its sidecars at every depth", () => {
    expect(classify([], "s.jsonl")).toBe("session");
    expect(classify([], "notes.md")).toBe("project-sidecar");
    expect(classify(["s1", "subagents"], "agent-a.jsonl")).toBe("subagent");
    expect(classify(["s1", "subagents"], "scratch.json")).toBe("subagent-sidecar");
    expect(classify(["s1", "subagents", "workflows", "wf_1"], "agent-a.jsonl")).toBe(
      "workflow-agent",
    );
    expect(classify(["s1", "subagents", "workflows", "wf_1"], "journal.jsonl")).toBe(
      "workflow-journal",
    );
  });
});
