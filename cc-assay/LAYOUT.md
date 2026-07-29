# The corpus layout

The on-disk / on-S3 shape of a mined corpus. `cc-assay` writes it; `cc-miner` reads
it. One layout serves three consumers — a local directory, an S3 prefix, and the
browser's local-bytes mode — and the point of writing it down is that all three
read it with the *same* glob and the *same* SQL.

## The path

```
<prefix>/<grain>/username=<user>/host=<hostId>[/month=<YYYY-MM>]/part0.parquet
<prefix>/index.json
```

Example:

```
s3://my-bucket/cc/turns/username=nehal/host=6f3a…-uuid/month=2026-07/part0.parquet
s3://my-bucket/cc/sessions/username=nehal/host=6f3a…-uuid/part0.parquet
```

Read — identically, whatever the prefix is:

```sql
SELECT * FROM read_parquet('<prefix>/turns/username=*/host=*/**/*.parquet',
                           hive_partitioning=true, union_by_name=true)
```

## Why these keys, in this order

**`username` first.** It is the analytical key: aggregation is per user, and "just
me" is the common filter. It is also the natural sharing boundary — one prefix can
hold several people's corpora and a reader can select or merge them.

**`host` second, and only to prevent collisions.** Two machines belonging to the
same user must not overwrite each other's files. Nobody filters by host, so it
sits below `username` and is never expected in a `WHERE` clause. It exists so
that `COPY` from a laptop cannot clobber `COPY` from a desktop.

The value is the **`hostId`** from `src/host.ts` — the stable minted UUID, not
`os.hostname()`. That module already states the rule and the reason: a hostname
"is a label, never a key", because "a rename would silently fork one machine's
history into two". As a partition key a rename is worse than a fork: history
written under the old name stays put while a re-sync rewrites it under the new
one, and the reader unions both. `index.json` carries the `hostId → hostname`
map, so paths stay correct and humans still get a readable name.

**`month` last, and optional.** Its job is **incremental upload**, not query
pruning: with it, a sync rewrites only the current month instead of the whole
grain. It is *not* how time filtering gets fast — the app filters on `ts`, never
on `month`, so pruning comes from Parquet row-group statistics regardless. Do not
add `month` expecting a query win.

The `**` in the read glob is what makes `month` optional: a grain with a month
level and a grain without both match, so the reader needs no per-grain knowledge.

## Which grains get `month`

Partition by month only when a grain is big enough for incremental upload to
matter. Measured on a 37-day corpus (30,420 turns):

| grain | size | month? | time column |
| --- | --- | --- | --- |
| `turns` | 3.82 MB | **yes** | `ts` |
| `toolCalls` | 1.74 MB | **yes** | `ts` |
| `events` | 0.02 MB | no | `ts` |
| `sessions` | 0.03 MB | no | `firstTs` / `lastTs` |
| `images` | 0.02 MB | no | `ts` |
| `forkEdges` | 0.004 MB | no | `forkPointTs` |
| `agentRuns` | 0.03 MB | no | `firstTs` / `lastTs` |
| `lineages` | 0.02 MB | no | `firstTs` / `lastTs` |

Two things to notice. The grains do **not** share a time column name, which is the
reason "partition everything by `strftime(ts,…)`" does not work and the writer
carries an explicit per-grain mapping. And the small grains are three orders of
magnitude below the big ones — monthly shards there would be a directory full of
20 KB files bought nothing.

**Rule of thumb:** add `month` above ~8 MB per user·host. If a single month ever
exceeds ~50 MB, add `day=` beneath it rather than changing the keys above.

## Shard size target

Local-bytes mode downloads whole shards — DuckDB-Wasm issues **one request and
zero range requests** per file, so a shard is atomic. Aim for **10–30 MB**:

| shard | ~loopback | ~100 Mbit |
| --- | --- | --- |
| 18 MB | 107 ms | ~1.5 s |
| 73 MB | 392 ms | ~6 s |

Today's real monthly `turns` shard is 3.57 MB — comfortably under, which is fine.
Smaller than target costs only file count; larger costs interactivity.

## Writing

```sql
COPY (SELECT *, strftime(ts, '%Y-%m') AS month, '<user>' AS username, '<host>' AS host
      FROM <grain>)
TO '<prefix>/<grain>'
  (FORMAT parquet, COMPRESSION zstd,
   PARTITION_BY (username, host, month),
   FILENAME_PATTERN 'part', OVERWRITE_OR_IGNORE);
```

Verified properties:

- The partition keys may be **computed in the SELECT** — `month` is derived from
  the grain's time column, never stored.
- `FILENAME_PATTERN 'part'` yields `part0.parquet` (DuckDB appends the index).
  With one file per partition the name is deterministic, so a re-run **overwrites
  rather than accumulates** — re-running the whole export twice leaves the same
  file count.
- `PARTITION_BY` **strips the key columns from the file**. They exist only in the
  path. This is not a detail you can ignore — see below.

For S3, the same statement with an `s3://` target, after one secret:

```sql
CREATE OR REPLACE SECRET cc_s3 (TYPE s3, PROVIDER credential_chain, PROFILE '<aws-profile>');
```

**`CHAIN` is not optional.** DuckDB's default credential chain has **no SSO
step**, so an `sso_session` profile fails outright at `CREATE SECRET` with
`Secret Validation Failure` — measured against a real SSO profile. `CHAIN 'sso'`
alone then breaks static profiles, so name all three sources:

```sql
CREATE OR REPLACE SECRET cc_s3 (
  TYPE s3, PROVIDER credential_chain,
  CHAIN 'env;sso;config', PROFILE '<aws-profile>');
```

That one statement is the entire AWS integration — no SDK, one credential
mechanism for both reading and writing.

**An expired SSO session is indistinguishable from a bad profile.** Measured with
an isolated `HOME` holding a deliberately expired token cache: both produce the
byte-identical

```
Invalid Configuration Error: Secret Validation Failure: during `create` …
Profile: '<p>'  Credential Chain: 'env;sso;config'
```

with no "expired", no "token", nothing to match on. So do **not** write a
regex that claims the session expired — it will be wrong half the time and send
the reader down the wrong path. Name both causes and offer
`aws sts get-caller-identity --profile <p>` as the disambiguator.

## `index.json`

One artifact, two consumers: the reader uses it to discover what exists without
listing the prefix, and local-bytes mode uses it to pick shards until it hits a
byte budget.

```json
{
  "version": 1,
  "generatedAt": "2026-07-28T12:00:00Z",
  "layout": "<grain>/username=<u>/host=<h>[/month=<YYYY-MM>]/part0.parquet",
  "users": ["nehal"],
  "hosts": { "6f3a…-uuid": "studio", "b21c…-uuid": "laptop" },
  "grains": {
    "turns":    { "partitionedByMonth": true,  "timeColumn": "ts" },
    "sessions": { "partitionedByMonth": false, "timeColumn": "firstTs" }
  },
  "shards": [
    { "grain": "turns", "username": "nehal", "host": "6f3a…-uuid",
      "month": "2026-07", "path": "turns/username=nehal/host=6f3a…-uuid/month=2026-07/part0.parquet",
      "bytes": 3570000, "rows": 28900 }
  ],
  "totals": { "bytes": 5600000, "rows": 67000 }
}
```

`shards[].path` is relative to the prefix, so the same index works for a local
directory and an S3 bucket.

**Local-bytes selection:** sort shards by `month` descending (undated shards
first — they are small and always wanted), take while the running `bytes` total
stays under budget. "How much do I load locally" becomes a number in config
rather than a second code path.

## Two rules that will bite you

**Register local buffers under their full Hive path.** In the browser you hand
DuckDB-Wasm a *name*, not a path, and the partition columns live only in the path:

```js
// ✗ partition columns are simply absent — "Binder Error: Referenced column host not found"
db.registerFileBuffer("turns.parquet", buf);
// ✓
db.registerFileBuffer("turns/username=nehal/host=6f3a…-uuid/month=2026-07/part0.parquet", buf);
```

Globbing over several such registered buffers works, and so does filtering on a
partition key — which is what makes local mode a *subset* of the same corpus
rather than a different one.

**`username` and `host` are not columns in the file.** Anything that reads a
shard without `hive_partitioning=true`, or without the path, will not see them.
That is the whole reason the read glob and the registration name are specified
here rather than left to each caller.
