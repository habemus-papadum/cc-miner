/**
 * export-cli.ts — write a mined corpus into the layout, locally or to S3.
 *
 *   pnpm export --from <dir-of-grains> --to <dir|s3://bucket/prefix> [--s3-profile <p>]
 *
 * The layout and the reasoning behind it are LAYOUT.md; the SQL is export.ts.
 * This file is only argument handling, iteration, and the index.
 */
import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import {
  attachS3,
  buildIndex,
  exportGrainSql,
  GRAINS,
  resolveHostIdentity,
  type ShardEntry,
} from "./export";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const from = arg("from");
  const to = arg("to");
  const s3Profile = arg("s3-profile");
  if (!from || !to) {
    console.error(
      "usage: export --from <dir> --to <dir|s3://bucket/prefix> [--s3-profile <p>] [--months <n>]",
    );
    process.exit(2);
  }
  const isS3 = to.startsWith("s3://");
  if (isS3 && !s3Profile) {
    console.error("--to is an s3:// prefix, so --s3-profile is required");
    process.exit(2);
  }

  const { username, hostId, hostname } = await resolveHostIdentity(from, arg("username"));
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  if (s3Profile) await attachS3(conn, s3Profile);
  if (!isS3) mkdirSync(to, { recursive: true });

  const months = arg("months") ? Number(arg("months")) : undefined;
  const opts = {
    prefix: to,
    username,
    hostId,
    sourceSql: (g: string) => `read_parquet('${path.resolve(from, `${g}.parquet`)}')`,
    ...(months ? { months } : {}),
  };
  if (months) console.log(`  (trimmed to the most recent ${months} month(s))`);

  const shards: ShardEntry[] = [];
  for (const grain of GRAINS) {
    if (!existsSync(path.resolve(from, `${grain.name}.parquet`))) {
      console.log(`  – ${grain.name}: absent from the source, skipped`);
      continue;
    }
    await conn.run(exportGrainSql(grain, opts));
    // `glob()` is DuckDB's, so it lists a local directory and an S3 prefix with
    // the same call — which is what keeps this loop single-path.
    const written = (
      await conn.runAndReadAll(`SELECT file FROM glob('${to}/${grain.name}/**/*.parquet')`)
    ).getRowObjects();
    for (const row of written) {
      const file = String(row.file);
      const rel = file.startsWith(to) ? file.slice(to.length + 1) : path.relative(to, file);
      const rows = Number(
        (
          await conn.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${file}')`)
        ).getRowObjects()[0]?.n ?? 0,
      );
      const month = rel.match(/month=([0-9]{4}-[0-9]{2})/)?.[1];
      shards.push({
        grain: grain.name,
        username,
        host: hostId,
        ...(month ? { month } : {}),
        path: rel,
        // Local prefixes get an exact size. On S3 there is no cheap stat, and a
        // wrong number is worse than an absent one — local-bytes mode falls back
        // to Content-Length at fetch time.
        ...(isS3 ? {} : { bytes: statSync(file).size }),
        rows,
      });
    }
    console.log(`  ✓ ${grain.name}`);
  }

  // Replay is per-session and read by path, not globbed as a grain — it travels
  // beside the partitions rather than inside them. On S3 there is no `cp`, so
  // each file is re-encoded through DuckDB; the schema is unchanged and it keeps
  // the whole tool free of an AWS SDK.
  const replaySrc = path.resolve(from, "replay");
  if (existsSync(replaySrc)) {
    if (isS3) {
      const files = globSync(`${replaySrc}/*.parquet`);
      for (const f of files) {
        await conn.run(
          `COPY (SELECT * FROM read_parquet('${f}')) TO '${to}/replay/${path.basename(f)}' ` +
            `(FORMAT parquet, COMPRESSION zstd)`,
        );
      }
      // The replay INDEX is metadata beside the shards, and the app is useless
      // without it — an earlier version uploaded only the .parquet files and the
      // panel reported "built without the replay grain".
      const idx = path.join(replaySrc, "index.json");
      if (existsSync(idx))
        await writeBlob(conn, `${to}/replay/index.json`, readFileSync(idx, "utf8"));
      console.log(`  ✓ replay/ (${files.length} sessions${existsSync(idx) ? " + index" : ""})`);
    } else {
      cpSync(replaySrc, path.join(to, "replay"), { recursive: true });
      console.log("  ✓ replay/");
    }
  }

  const manifest = path.resolve(from, "manifest.json");
  if (existsSync(manifest)) {
    if (isS3) await writeBlob(conn, `${to}/manifest.json`, readFileSync(manifest, "utf8"));
    else cpSync(manifest, path.join(to, "manifest.json"));
  }

  const index = buildIndex(shards, { users: [username], hosts: { [hostId]: hostname } });
  const json = `${JSON.stringify(index, null, 2)}\n`;
  if (isS3) await writeBlob(conn, `${to}/index.json`, json);
  else writeFileSync(path.join(to, "index.json"), json);

  const size = index.totals.bytes ? `${(index.totals.bytes / 1e6).toFixed(2)} MB, ` : "";
  console.log(`\n  ${shards.length} shards, ${size}${index.totals.rows} rows → ${to}`);
}

/**
 * Write an arbitrary text file to a local path or S3, using only DuckDB.
 *
 * The CSV writer with quoting disabled emits the value verbatim, which is the
 * one way to put a non-Parquet blob on S3 without pulling in an AWS SDK just for
 * two small files.
 */
async function writeBlob(conn: DuckDBConnection, target: string, contents: string): Promise<void> {
  const literal = contents.replaceAll("'", "''");
  await conn.run(
    `COPY (SELECT '${literal}' AS blob) TO '${target}' ` +
      `(FORMAT csv, HEADER false, QUOTE '', DELIMITER ',')`,
  );
}

main().catch((e) => {
  const msg = String(e?.message ?? e);
  // Measured: an EXPIRED SSO session and a MISCONFIGURED profile produce the
  // byte-identical "Secret Validation Failure" — no "expired", no "token", no
  // way to tell them apart from the message. So this does not guess. Naming
  // both causes is more useful than confidently naming the wrong one.
  if (/Secret Validation Failure|credential_chain/i.test(msg)) {
    const p = process.argv[process.argv.indexOf("--s3-profile") + 1] ?? "<profile>";
    console.error(
      `\nDuckDB could not resolve AWS credentials for profile '${p}'.\n` +
        `DuckDB's error does not distinguish these, so check both:\n` +
        `  • the SSO session has expired   →  aws sso login --profile ${p}\n` +
        `  • the profile is missing or misnamed in ~/.aws/config\n` +
        `Confirm with: aws sts get-caller-identity --profile ${p}\n`,
    );
  }
  console.error(msg);
  process.exit(1);
});
