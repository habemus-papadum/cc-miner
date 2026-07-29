/**
 * source.ts — where the data comes from, declared rather than discovered.
 *
 * Two modes, and the app is always in exactly one of them **because it was
 * told to be**, never because of what happened to be running:
 *
 *   local  Parquet shipped with the app, served by Vite, queried by
 *          duckdb-wasm in the tab. No server. Fast to start, small corpus.
 *   host   a native DuckDB answering over Quack, reading a local directory or
 *          S3. The full corpus, and the only mode that scales.
 *
 * **There is deliberately no fallback.** Asking for `host` when no host is
 * running is an error, not a quiet downgrade to local — otherwise the same
 * command means different things on two machines, and a stale local corpus
 * silently stands in for the real one. That failure is invisible in the UI and
 * expensive in trust, which is exactly the class of bug this app keeps finding
 * in itself.
 *
 * The two modes must expose the SAME tables under the SAME names, because
 * everything above this file is written once. That is what the Hive layout buys:
 * a registered buffer named `turns/username=…/host=…/month=…/part0.parquet` and
 * an S3 prefix answer the identical globbed `read_parquet` over
 * `turns/username=<any>/host=<any>` — see createLocalViews in store.ts.
 */
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import type { Connector } from "@uwdata/mosaic-core";
import { wasmConnector } from "@uwdata/vgplot";
import { fetchHostInfo, type HostInfo, quackConnector } from "./quack";
import type { SourceMode } from "./source-mode";

/**
 * Session ids are concatenated into SQL and into a fetch path, so they are
 * checked rather than trusted. They come from our own corpus and are UUIDs; a
 * value that is not one is a bug or an attack, and both should stop here.
 */
function assertSessionId(id: string): void {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    throw new Error(`refusing to build a replay reference for a non-UUID session id: ${id}`);
  }
}

/** What a resolved source hands the store. Both modes fill this identically. */
export interface DataSource {
  mode: SourceMode;
  /** Human-readable provenance for the UI: "local bytes", "host · s3://…". */
  label: string;
  connector: Connector;
  manifest: unknown;
  replayIndex: unknown;
  /** Grains actually available. */
  grains: string[];
  /**
   * Create the tables the app queries. A no-op in host mode — the host made
   * them at boot — and the real work in local mode.
   */
  createViews: (exec: (sql: string) => Promise<unknown>) => Promise<void>;
  /** SQL literal for a session's replay file, or null when unsupported. */
  replayFile: (sessionId: string) => string | null;
}

/**
 * Every Parquet file shipped with the app, keyed by its path under `src/data`.
 *
 * `import.meta.glob` rather than named `?url` imports because the layout embeds
 * a host UUID that differs per machine — there is no static path to write. The
 * glob keys ARE the Hive paths, which is exactly what the registration names
 * have to be.
 */
const LOCAL_FILES = import.meta.glob("../data/**/*.parquet", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** `../data/turns/username=x/…/part0.parquet` → `turns/username=x/…/part0.parquet` */
function registrationName(globKey: string): string {
  return globKey.replace(/^\.\.\/data\//, "");
}

async function localSource(
  db: AsyncDuckDB,
  onProgress: (f: number, label: string) => void,
): Promise<Record<string, string[]>> {
  // Replay files are per-session and read on demand; they must NOT be registered
  // at boot or local mode would pull the whole replay grain to show one session.
  const shards = Object.entries(LOCAL_FILES).filter(([k]) => !k.includes("/replay/"));
  const byGrain: Record<string, string[]> = {};
  let done = 0;
  for (const [key, url] of shards) {
    const name = registrationName(key);
    const grain = name.split("/")[0] ?? "";
    onProgress(done / shards.length, `loading ${grain}`);
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    // The registration name carries the FULL Hive path. A flat name would drop
    // the partition columns entirely — they live only in the path, never in the
    // file — and every query naming `username` or `host` would fail to bind.
    await db.registerFileBuffer(name, buf);
    byGrain[grain] ??= [];
    byGrain[grain].push(name);
    done++;
  }
  return byGrain;
}

export interface ResolveOptions {
  db: AsyncDuckDB;
  connection: unknown;
  onProgress: (fraction: number, label: string) => void;
}

/** Resolve the declared mode into a usable source, or fail loudly. */
export async function resolveSource(
  mode: SourceMode,
  { db, connection, onProgress }: ResolveOptions,
): Promise<DataSource> {
  if (mode === "host") {
    const info: HostInfo = await fetchHostInfo();
    if (!info.ok || !info.token || !info.quackUri) {
      // Deliberately terminal. See the note at the top of this file.
      throw new Error(
        `${info.error ?? "the DuckDB host is not running"}\n` +
          `You are in HOST mode; local bytes are not substituted automatically.`,
      );
    }
    const src = info.source as { kind?: string; prefix?: string; dataDir?: string } | undefined;
    return {
      mode: "host",
      label: `host · ${src?.prefix ?? src?.dataDir ?? "unknown source"}`,
      connector: quackConnector({ connection, uri: info.quackUri, token: info.token }),
      manifest: info.manifest ?? null,
      replayIndex: info.replayIndex ?? null,
      grains: info.grains ?? [],
      // The host built its views at boot, over a directory or an S3 prefix.
      createViews: async () => {},
      replayFile: (id) => {
        assertSessionId(id);
        return info.replayBase ? `'${info.replayBase}/${id}.parquet'` : null;
      },
    };
  }

  const byGrain = await localSource(db, onProgress);
  const [manifest, replayIndex] = await Promise.all([
    fetch(new URL("../data/manifest.json", import.meta.url))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(new URL("../data/replay/index.json", import.meta.url))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  return {
    mode: "local",
    label: "local bytes",
    connector: wasmConnector({ duckdb: db, connection } as never) as Connector,
    manifest,
    replayIndex,
    grains: Object.keys(byGrain),
    // An EXPLICIT LIST, not a glob. Over duckdb-wasm's virtual filesystem of
    // registered buffers, `**` matches one path segment but NOT zero — measured
    // — so the glob the host uses silently finds nothing for the grains that
    // have no `month=` level. Listing what we just registered is both correct
    // and more honest: the view contains exactly the bytes we loaded.
    createViews: async (exec) => {
      for (const [grain, files] of Object.entries(byGrain)) {
        const list = files.map((f) => `'${f}'`).join(", ");
        await exec(
          `CREATE OR REPLACE VIEW "${grain}" AS SELECT * FROM read_parquet([${list}], ` +
            `hive_partitioning=true, union_by_name=true)`,
        );
      }
    },
    // Local replay is fetched and registered on demand by the store; the file
    // reference is the registration name it will use.
    replayFile: (id) => {
      assertSessionId(id);
      return `'replay/${id}.parquet'`;
    },
  };
}
