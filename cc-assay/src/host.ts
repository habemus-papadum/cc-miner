/**
 * Host identity for the raw layer.
 *
 * The raw ingest is per machine and its output is meant to travel — rsync'd,
 * synced to object storage, merged with other machines' output at analytics
 * time. So every row needs to say which machine it came from, and that answer
 * has to survive a hostname change.
 *
 * `os.hostname()` is the obvious key and the wrong one on its own: laptops get
 * renamed, containers get random names, and a rename would silently fork one
 * machine's history into two. So the id is minted once, written to disk beside
 * the raw output, and reused forever after; the hostname rides along as a
 * human-readable label that is allowed to change.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import path from "node:path";

export interface HostIdentity {
  /** Stable across renames. Minted once, then read from disk. */
  hostId: string;
  /** Human-readable, may change between runs — a label, never a key. */
  hostname: string;
  platform: string;
  release: string;
  /** When this identity was first minted. */
  createdAt: string;
}

const FILE = "host.json";

/**
 * Read the host identity beside `dir`, minting and persisting one on first run.
 *
 * The hostname is refreshed on every read so a renamed machine shows its
 * current name while keeping its original `hostId` — which is the whole point.
 */
export async function resolveHost(dir: string): Promise<HostIdentity> {
  const file = path.join(dir, FILE);
  let stored: Partial<HostIdentity> = {};
  try {
    stored = JSON.parse(await readFile(file, "utf8")) as Partial<HostIdentity>;
  } catch {
    /* first run for this directory */
  }
  const identity: HostIdentity = {
    hostId: stored.hostId ?? randomUUID(),
    hostname: hostname(),
    platform: platform(),
    release: release(),
    createdAt: stored.createdAt ?? new Date().toISOString(),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

/**
 * A project's identity *across* hosts.
 *
 * `projectSlug` is a path with `/` replaced by `-`, so the same repository
 * checked out at `/Users/nehal/src/pdum_aiui` and `/home/nehal/src/pdum_aiui`
 * produces two different slugs and would never merge. Analytics that group by
 * project across machines need something stabler than the path.
 *
 * The basename of the repository root is a weak key (two unrelated `docs/`
 * checkouts collide) but it is derivable from data we already have. A git
 * remote URL would be stronger and is the obvious upgrade — it needs the repo
 * to still exist on disk, which is not true for every historical session, so it
 * belongs in an enrichment pass rather than here.
 */
export const projectKey = (repoRootPath: string): string =>
  repoRootPath.split("/").filter(Boolean).at(-1) ?? repoRootPath;
