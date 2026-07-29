import { describe, expect, it } from "vitest";
import {
  buildIndex,
  type CorpusIndex,
  exportGrainSql,
  GRAINS,
  type ShardEntry,
  selectShards,
} from "./export";

const opts = {
  prefix: "s3://bucket/cc",
  username: "nehal",
  hostId: "6f3a2b1c",
  sourceSql: (g: string) => `read_parquet('/data/${g}.parquet')`,
};

const grain = (name: string) => {
  const g = GRAINS.find((x) => x.name === name);
  expect(g).toBeDefined();
  return g as (typeof GRAINS)[number];
};

describe("exportGrainSql", () => {
  it("adds a month level only for the grains that want one", () => {
    expect(exportGrainSql(grain("turns"), opts)).toContain("PARTITION_BY (username, host, month)");
    expect(exportGrainSql(grain("sessions"), opts)).toContain("PARTITION_BY (username, host)");
    expect(exportGrainSql(grain("sessions"), opts)).not.toContain("month");
  });

  it("derives month from each grain's OWN time column", () => {
    // The bug this guards: assuming every grain has `ts`. `sessions` has
    // `firstTs`, `forkEdges` has `forkPointTs`.
    expect(exportGrainSql(grain("turns"), opts)).toContain(`strftime("ts", '%Y-%m')`);
    const monthly = GRAINS.filter((g) => g.partitionedByMonth);
    for (const g of monthly) {
      expect(exportGrainSql(g, opts)).toContain(`strftime("${g.timeColumn}", '%Y-%m')`);
    }
  });

  it("writes deterministic filenames and overwrites, so a re-run is idempotent", () => {
    const sql = exportGrainSql(grain("turns"), opts);
    expect(sql).toContain("FILENAME_PATTERN 'part'");
    expect(sql).toContain("OVERWRITE_OR_IGNORE");
  });

  it("targets the grain's own subtree of the prefix", () => {
    expect(exportGrainSql(grain("turns"), opts)).toContain("TO 's3://bucket/cc/turns'");
  });

  it("accepts ordinary usernames containing dots", () => {
    expect(() => exportGrainSql(grain("turns"), { ...opts, username: "first.last" })).not.toThrow();
    expect(() => exportGrainSql(grain("turns"), { ...opts, username: "a.b@c-d_e" })).not.toThrow();
  });

  it("rejects partition values that would not survive a path round trip", () => {
    for (const bad of ["a/b", "..", "../..", "a/../b", "...", "with space", "quote'd", ""]) {
      expect(() => exportGrainSql(grain("turns"), { ...opts, username: bad })).toThrow(
        /not safe as a partition key/,
      );
      expect(() => exportGrainSql(grain("turns"), { ...opts, hostId: bad })).toThrow(
        /not safe as a partition key/,
      );
    }
  });
});

describe("selectShards", () => {
  const shard = (over: Partial<ShardEntry>): ShardEntry => ({
    grain: "turns",
    username: "nehal",
    host: "h",
    path: `p/${over.month ?? "flat"}-${over.grain ?? "turns"}`,
    bytes: 1_000_000,
    rows: 100,
    ...over,
  });

  const index = (shards: ShardEntry[]): CorpusIndex =>
    buildIndex(shards, { users: ["nehal"], hosts: { h: "studio" } });

  it("takes undated shards first — they are small and always wanted", () => {
    const picked = selectShards(
      index([
        shard({ month: "2026-07" }),
        shard({ grain: "sessions", bytes: 30_000 }),
        shard({ month: "2026-06" }),
      ]),
      50_000,
    );
    expect(picked).toHaveLength(1);
    expect(picked[0]?.grain).toBe("sessions");
  });

  it("prefers newer months and stops at the budget", () => {
    const picked = selectShards(
      index([
        shard({ month: "2026-05" }),
        shard({ month: "2026-07" }),
        shard({ month: "2026-06" }),
      ]),
      2_500_000,
    );
    expect(picked.map((s) => s.month)).toEqual(["2026-07", "2026-06"]);
  });

  it("is deterministic for the same index and budget", () => {
    const i = index([
      shard({ month: "2026-07" }),
      shard({ month: "2026-06" }),
      shard({ grain: "events", bytes: 20_000 }),
    ]);
    expect(selectShards(i, 1_500_000)).toEqual(selectShards(i, 1_500_000));
  });

  it("skips an oversized shard rather than aborting the whole selection", () => {
    const picked = selectShards(
      index([shard({ month: "2026-07", bytes: 99_000_000 }), shard({ month: "2026-06" })]),
      2_000_000,
    );
    expect(picked.map((s) => s.month)).toEqual(["2026-06"]);
  });
});

describe("buildIndex", () => {
  it("records every grain's partitioning decision, not just the written ones", () => {
    const i = buildIndex([], { users: [], hosts: {} });
    expect(Object.keys(i.grains).sort()).toEqual(GRAINS.map((g) => g.name).sort());
    expect(i.grains.turns?.partitionedByMonth).toBe(true);
    expect(i.grains.sessions?.partitionedByMonth).toBe(false);
    expect(i.grains.forkEdges?.timeColumn).toBe("forkPointTs");
  });

  it("totals what it was given", () => {
    const i = buildIndex(
      [
        { grain: "turns", username: "n", host: "h", path: "a", bytes: 10, rows: 2 },
        { grain: "events", username: "n", host: "h", path: "b", bytes: 5, rows: 3 },
      ],
      { users: ["n"], hosts: { h: "studio" } },
    );
    expect(i.totals).toEqual({ bytes: 15, rows: 5 });
  });
});
