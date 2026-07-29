/**
 * Fork lineage: turning a pile of session *files* into a forest of sessions.
 *
 * Forking or resuming does not reference a parent — it **copies** the inherited
 * transcript prefix into the new session's file, preserving `uuid`, `timestamp`,
 * `requestId` and `message.id` byte for byte (proposal §1.6). So the parent→child
 * edge is not written down anywhere; it has to be recovered. Two recipes:
 *
 *  1. **The marker.** From Claude Code 2.1.199, a copied record keeps its
 *     originating session in `session_id` while `sessionId` is rewritten to the
 *     containing file.
 *  2. **UUID overlap.** Before 2.1.199 there is no marker at all, so the edge
 *     must come from content: the child's file *begins* with records that also
 *     exist in the parent's file.
 *
 * **The marker names an ancestor, not necessarily the parent**, and this corpus
 * proves it. When a fork is itself forked, the second child's inherited prefix
 * ends in records the first child produced — and those are `system` / `user`
 * records, which on the builds in question carry no `session_id` at all. The last
 * *marked* record therefore still names the grandparent, and believing it turns a
 * chain into a star (`63baa90e → 4df4dbb9 → {70486150, de93c3a5}` reads as three
 * siblings of `63baa90e`). So content picks the parent whenever there is any, and
 * the marker is used to confirm it, to name a parent content cannot see, and to
 * catch the continuation case below.
 *
 * Content overlap is symmetric — "these two files share 1,575 leading records"
 * says nothing about which way the copy went — so direction needs its own
 * evidence, and this module uses three signals in order:
 *
 *  - **Length.** In a chain root→P→B, B's leading run matches more of P than of
 *    root (P's own turns are not in root), so the longest run names the *direct*
 *    parent rather than an ancestor.
 *  - **Shape.** In the child, the shared records are a contiguous prefix by
 *    construction. In the parent they usually are not: any record the fork
 *    dropped (compaction, a rewind) leaves a gap, and a fork taken mid-history
 *    puts the shared block in the middle of the parent's file. A candidate whose
 *    shared block is *not* its own leading prefix therefore cannot be the copy —
 *    it must be the original. This is the only signal that is proof rather than
 *    inference, and it is recorded as such.
 *  - **File creation order.** When both files hold the shared records as a clean
 *    leading prefix (fork with nothing dropped), content genuinely cannot tell
 *    parent from child, and the tie is broken by which file was created first.
 *    Edges resolved this way are flagged `ambiguous` — a widget that draws them
 *    identically to proven edges is lying.
 *
 * Two shapes this deliberately does **not** claim to resolve: a session forked
 * from a transcript that has since been deleted (the parent simply is not in the
 * corpus), and two siblings forked from the same point of an unmarked parent
 * that dropped nothing — content makes those look exactly like parent and child.
 * Both surface as `ambiguous` or as an unresolved reason rather than as a
 * confident edge.
 */

/** Everything lineage resolution needs from one session-kind transcript file. */
export interface SessionDigest {
  sessionId: string;
  projectSlug: string;
  /** File birthtime in ms — the wall-clock moment a fork came into existence. */
  createdMs?: number;
  /** uuids of every uuid-bearing record, in file order. */
  uuids: string[];
  /** Timestamps parallel to `uuids`, ms; 0 when the record carried none. */
  ts: number[];
  uuidSet: Set<string>;
  /** Origin named by the LAST marker-inherited record, when any carried one. */
  markerParent?: string;
  markerParentTs?: number;
  markerInherited: number;
  /** Any record at all carried `session_id` — i.e. the build was 2.1.199+. */
  markerPresent: boolean;
  records: number;
}

export type ParentSource = "marker" | "uuid-overlap";

/**
 * What the child actually took from the parent.
 *
 * `copy` is §1.6's fork: the inherited prefix is physically present in the
 * child's file. `continuation` is a shape the proposal did not describe and this
 * corpus contains — a session whose every record carries `session_id` pointing
 * at an earlier session while sharing **not one uuid** with it. Claude Code
 * 2.1.220 writes it when a session is continued into a fresh file: the link is
 * real, but nothing was inherited on disk, and the child's first turn starts a
 * new cache (`cache_read = 0`) rather than re-reading the parent's context.
 *
 * The distinction matters twice over. Attribution: a continuation's records are
 * the child's own, so crediting them to `session_id` (which the marker alone
 * would do) hands a whole session's cost to its predecessor. And drawing: a copy
 * edge branches out of the middle of the parent's life, a continuation edge
 * leaves from its end.
 */
export type ForkKind = "copy" | "continuation";

export interface ForkEdge {
  childSessionId: string;
  parentSessionId: string;
  source: ParentSource;
  kind: ForkKind;
  /** Direction rested on file creation order, not on content. Draw it dashed. */
  ambiguous: boolean;
  /** A marker named the parent but no file for it is in the corpus. */
  parentMissing: boolean;
  /**
   * Where the child branched off, **in the parent's timeline** — the timestamp
   * of the last inherited record. The origin of the timeline widget's bezier.
   */
  forkPointTs: number;
  /** File birthtime of the child, 0 when unknown. */
  childCreatedTs: number;
  /**
   * First record the child produced itself. The bezier's other endpoint, and it
   * can be days after `forkPointTs` — a fork of a long-cold session is normal.
   */
  childFirstNativeTs: number;
  /** How many records the child carried in from its ancestors. */
  inheritedRecords: number;
}

export interface LineageResolution {
  /** child sessionId → edge. Sessions absent from this map are roots. */
  edges: Map<string, ForkEdge>;
  /** sessionId → the root of its fork family. Own id for a root. */
  lineageId: Map<string, string>;
  /** Hops to the root; 0 for a root. */
  depth: Map<string, number>;
  /** sessionId → [root, …, self]. Used to attribute an inherited record. */
  chain: Map<string, string[]>;
  /** Sessions that look forked but whose parent could not be named, and why. */
  unresolved: { sessionId: string; reason: string }[];
}

/**
 * Where `child` branched off `ancestor`, in **`ancestor`'s** timeline.
 *
 * Works for any ancestor, not just the direct parent, which is what makes a
 * chain drawable when a link in it has nothing to draw: a session that forked
 * and produced no billed turn is a real node with no bar, and a timeline that
 * hangs its children off it loses them. Asking the same question of the nearest
 * ancestor that DOES have turns gives an honest anchor — the last record the
 * child inherited that this ancestor actually produced — rather than a
 * fabricated edge.
 *
 * `run` of 0 means nothing was copied (a continuation), and the branch point is
 * the ancestor's last breath.
 */
export function branchPoint(
  child: SessionDigest,
  ancestor: SessionDigest,
): { run: number; ts: number } {
  const run = leadingRun(child, ancestor.uuidSet);
  return {
    run,
    ts: run > 0 ? child.ts[run - 1] : (ancestor.ts[ancestor.ts.length - 1] ?? 0),
  };
}

/** How much of `child`'s head also exists in `parent`. */
function leadingRun(child: SessionDigest, parentSet: Set<string>): number {
  let n = 0;
  while (n < child.uuids.length && parentSet.has(child.uuids[n])) n++;
  return n;
}

/**
 * Where a set of shared uuids sits inside a candidate's own file.
 *
 * `ownPrefix` is the discriminator: true means the candidate's copy of those
 * records is *its own* leading prefix, which is exactly what a child looks like,
 * so the candidate might itself be the copy. False means the records sit behind
 * or among records the other file does not have — only an original can look
 * like that.
 */
function blockShape(
  cand: SessionDigest,
  shared: Set<string>,
): { count: number; ownPrefix: boolean } {
  let count = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < cand.uuids.length; i++) {
    if (!shared.has(cand.uuids[i])) continue;
    if (first < 0) first = i;
    last = i;
    count++;
  }
  return { count, ownPrefix: count > 0 && first === 0 && last === count - 1 };
}

interface Candidate {
  parent: SessionDigest;
  run: number;
  structural: boolean;
}

/**
 * Resolve the fork forest over every session-kind file in the corpus.
 *
 * Linear in records plus O(candidates) per session: the only cross-file index is
 * uuid → sessions, built for *head* uuids alone, so a session's candidate
 * parents are the handful of files that contain its first record rather than
 * every file in the corpus. The naive O(files²) intersection the proposal warned
 * about (§6) is not needed.
 */
export function resolveLineage(digests: SessionDigest[]): LineageResolution {
  const bySession = new Map(digests.map((d) => [d.sessionId, d]));
  const unresolved: { sessionId: string; reason: string }[] = [];

  // uuid → sessions whose file STARTS with it. Only head uuids are indexed, so
  // one pass over the corpus is enough to find every candidate parent.
  const heads = new Set<string>();
  for (const d of digests) if (d.uuids.length) heads.add(d.uuids[0]);
  const containsHead = new Map<string, SessionDigest[]>();
  for (const d of digests) {
    for (const u of d.uuids) {
      if (!heads.has(u)) continue;
      const list = containsHead.get(u);
      if (list) {
        if (list[list.length - 1] !== d) list.push(d);
      } else containsHead.set(u, [d]);
    }
  }

  const parentOf = new Map<string, { parent: string; source: ParentSource; ambiguous: boolean }>();

  for (const child of digests) {
    const marker =
      child.markerParent && child.markerParent !== child.sessionId ? child.markerParent : undefined;
    const head = child.uuids[0];
    const cands: Candidate[] = [];
    for (const cand of head ? (containsHead.get(head) ?? []) : []) {
      if (cand.sessionId === child.sessionId) continue;
      const run = leadingRun(child, cand.uuidSet);
      if (run === 0) continue;
      const shared = new Set(child.uuids.slice(0, run));
      const shape = blockShape(cand, shared);
      // A candidate created after the child cannot have been copied from.
      if (cand.createdMs && child.createdMs && cand.createdMs > child.createdMs) continue;
      cands.push({ parent: cand, run, structural: !shape.ownPrefix });
    }
    if (cands.length === 0) {
      // No shared records. A marker here is still a real link — a continuation,
      // where the session was carried into a fresh file rather than copied.
      if (marker) {
        parentOf.set(child.sessionId, { parent: marker, source: "marker", ambiguous: false });
      }
      continue;
    }
    cands.sort(
      (a, b) =>
        b.run - a.run ||
        Number(b.structural) - Number(a.structural) ||
        (a.parent.createdMs ?? Infinity) - (b.parent.createdMs ?? Infinity),
    );
    const best = cands[0];
    const agreesWithMarker = marker !== undefined && marker === best.parent.sessionId;
    if (!best.structural && !agreesWithMarker && !(best.parent.createdMs && child.createdMs)) {
      // Symmetric prefixes, no marker to confirm, and no creation times: which
      // file is the copy is not decidable. Say so rather than guess.
      unresolved.push({
        sessionId: child.sessionId,
        reason: `shares ${best.run} leading records with ${best.parent.sessionId} but direction is undecidable`,
      });
      continue;
    }
    parentOf.set(child.sessionId, {
      parent: best.parent.sessionId,
      source: agreesWithMarker ? "marker" : "uuid-overlap",
      ambiguous: !best.structural && !agreesWithMarker,
    });
  }

  // A cycle would mean two files each claiming to be the other's copy. It cannot
  // happen with correct evidence, so treat it as a bug in the evidence and drop
  // the edge rather than hang the depth walk.
  for (const sessionId of [...parentOf.keys()]) {
    const seen = new Set<string>([sessionId]);
    let cur = parentOf.get(sessionId)?.parent;
    while (cur) {
      if (seen.has(cur)) {
        parentOf.delete(sessionId);
        unresolved.push({ sessionId, reason: `parent chain cycles through ${cur}` });
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur)?.parent;
    }
  }

  const chain = new Map<string, string[]>();
  const chainOf = (sessionId: string): string[] => {
    const memo = chain.get(sessionId);
    if (memo) return memo;
    const p = parentOf.get(sessionId)?.parent;
    const out = p ? [...chainOf(p), sessionId] : [sessionId];
    chain.set(sessionId, out);
    return out;
  };
  const lineageId = new Map<string, string>();
  const depth = new Map<string, number>();
  for (const d of digests) {
    const c = chainOf(d.sessionId);
    lineageId.set(d.sessionId, c[0]);
    depth.set(d.sessionId, c.length - 1);
    // Content may name a nearer parent than the marker, but it must never
    // contradict it: the marked session has to be somewhere up the chain. If it
    // is not, one of the two signals is being misread and the reader deserves to
    // know rather than to see a confident wrong edge.
    const marker = d.markerParent;
    if (marker && marker !== d.sessionId && !c.includes(marker)) {
      unresolved.push({
        sessionId: d.sessionId,
        reason: `marker names ${marker} but content places the chain at ${c.join(" → ")}`,
      });
    }
  }

  const edges = new Map<string, ForkEdge>();
  for (const [childId, link] of parentOf) {
    const child = bySession.get(childId);
    if (!child) continue;
    const parent = bySession.get(link.parent);
    // The uuid run is the honest prefix length even on the marker path: many
    // record types (attachments, mode changes) never carry `session_id`, so the
    // last *marked* record can sit well before the real boundary — and a
    // continuation has a marker on every record while sharing none of them.
    const run = parent ? leadingRun(child, parent.uuidSet) : 0;
    const parentLastTs = parent?.ts.length ? parent.ts[parent.ts.length - 1] : 0;
    edges.set(childId, {
      childSessionId: childId,
      parentSessionId: link.parent,
      source: link.source,
      // A marker with zero shared records is a continuation, not a copy. Content
      // decides this, never the marker — see ForkKind.
      kind: run > 0 ? "copy" : "continuation",
      ambiguous: link.ambiguous,
      parentMissing: !parent,
      // A copy branches where the copying stopped; a continuation leaves from
      // the parent's last breath. With the parent's file gone there is no honest
      // answer, so say 0 rather than invent one from the child's own clock.
      forkPointTs: run > 0 ? child.ts[run - 1] : parentLastTs,
      childCreatedTs: child.createdMs ?? 0,
      childFirstNativeTs: run < child.ts.length ? child.ts[run] : 0,
      inheritedRecords: run,
    });
  }

  return { edges, lineageId, depth, chain, unresolved };
}

/**
 * Which session actually produced a record, for the builds that left no marker.
 *
 * A record whose uuid exists in an ancestor's file was copied in, and the
 * *root-most* ancestor holding it is the one that produced it — a fork of a fork
 * carries its grandparent's records too. Without this, an unmarked fork is
 * credited with every turn it inherited and appears to have started days before
 * it did, which is precisely the distortion a timeline must not show.
 */
export function originForRecord(
  lineage: LineageResolution,
  fileSessionId: string,
  uuid: string | undefined,
  digests: Map<string, SessionDigest>,
): string {
  if (!uuid) return fileSessionId;
  const c = lineage.chain.get(fileSessionId);
  if (!c || c.length < 2) return fileSessionId;
  for (let i = 0; i < c.length - 1; i++) {
    if (digests.get(c[i])?.uuidSet.has(uuid)) return c[i];
  }
  return fileSessionId;
}
