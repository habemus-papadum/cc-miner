/**
 * invariants.ts — the checks that must hold over a finished corpus.
 *
 * Independent of the Normalizer by construction: it takes a `Normalized` and
 * returns problems, which is why it separates cleanly. The CLI runs it on every
 * mine and exits non-zero on failure — a silent regression in the dedup path is
 * exactly the failure this package exists to prevent.
 */
import type { Normalized } from "./grains.ts";

export interface InvariantResult {
  ok: boolean;
  problems: string[];
}

/**
 * The checks that would catch a regression in the dedup/attribution path.
 * Cheap enough to run on every normalize, and the CLI does.
 *
 * Deliberately scoped to *our* faults — double-counting, lost attribution,
 * dedup running backwards, a lineage that does not close. Upstream malformation
 * (a record with no timestamp, a usage blob that is a string) is counted in
 * `stats`, not failed here: the whole premise of this package is that it
 * survives whatever Claude Code writes, so malformed input must not be reported
 * as a broken pipeline.
 */
export function checkInvariants(n: Normalized): InvariantResult {
  const problems: string[] = [];
  const eps = 1e-6;

  const turnTotal = n.turns.reduce((s, t) => s + t.costTotal, 0);
  const sessionTotal = n.sessions.reduce((s, r) => s + r.nativeCost, 0);
  if (Math.abs(turnTotal - sessionTotal) > Math.max(eps, turnTotal * 1e-9)) {
    problems.push(
      `SUM(sessions.nativeCost)=${sessionTotal} != SUM(turns.costTotal)=${turnTotal} — ` +
        "a turn was attributed to no session, or double-counted.",
    );
  }

  const ids = new Set<string>();
  for (const t of n.turns) {
    const k = `${t.messageId} ${t.requestId ?? ""}`;
    if (ids.has(k)) problems.push(`duplicate billing key survived dedup: ${t.messageId}`);
    ids.add(k);
  }

  if (n.stats.dedupedOutputTokens > n.stats.naiveOutputTokens) {
    problems.push(
      "deduped output exceeds the naive sum — dedup is adding tokens, not removing them.",
    );
  }

  // --- lineage closes over itself ---
  const bySession = new Map(n.sessions.map((s) => [s.sessionId, s]));
  for (const s of n.sessions) {
    if (!s.parentSessionId) {
      if (s.depth !== 0) problems.push(`${s.sessionId}: no parent but depth ${s.depth}`);
      if (s.lineageId !== s.sessionId) {
        problems.push(`${s.sessionId}: root of no lineage yet lineageId ${s.lineageId}`);
      }
      continue;
    }
    const parent = bySession.get(s.parentSessionId);
    if (!parent) {
      // A marker can name a parent whose file is gone; that is data, not a bug,
      // and the edge row carries `parentMissing` to say so. Anything else is us.
      const edge = n.forkEdges.find((e) => e.childSessionId === s.sessionId);
      if (!edge?.parentMissing) {
        problems.push(`${s.sessionId}: parent ${s.parentSessionId} is not a session row`);
      }
      continue;
    }
    if (s.depth !== parent.depth + 1) {
      problems.push(`${s.sessionId}: depth ${s.depth} but parent's is ${parent.depth}`);
    }
    if (s.lineageId !== parent.lineageId) {
      problems.push(`${s.sessionId}: lineage ${s.lineageId} != parent's ${parent.lineageId}`);
    }
    // A child cannot start before the point it branched from.
    const start = s.firstNativeTs || s.createdTs || s.firstTs;
    if (s.forkPointTs && start && start < s.forkPointTs) {
      problems.push(
        `${s.sessionId}: starts ${new Date(start).toISOString()} before its fork point ` +
          `${new Date(s.forkPointTs).toISOString()} — the edge is drawn backwards.`,
      );
    }
  }

  if (n.forkEdges.length !== n.sessions.filter((s) => s.parentSessionId).length) {
    problems.push(
      `forkEdges=${n.forkEdges.length} but ${n.sessions.filter((s) => s.parentSessionId).length} ` +
        "sessions claim a parent — the two grains disagree.",
    );
  }

  // --- the agent grain accounts for every sidechain turn exactly once ---
  const sideTurns = n.turns.filter((t) => t.context !== "main" && t.agentId);
  const agentTurnTotal = n.agentRuns.reduce((s, a) => s + a.nTurns, 0);
  if (agentTurnTotal !== sideTurns.length) {
    problems.push(
      `SUM(agentRuns.nTurns)=${agentTurnTotal} != ${sideTurns.length} agent turns — ` +
        "an agent run lost or duplicated turns.",
    );
  }

  const lineageTotal = n.lineages.reduce((s, l) => s + l.totalCost, 0);
  if (Math.abs(lineageTotal - turnTotal) > Math.max(eps, turnTotal * 1e-9)) {
    problems.push(
      `SUM(lineages.totalCost)=${lineageTotal} != SUM(turns.costTotal)=${turnTotal} — ` +
        "a session belongs to no lineage.",
    );
  }

  return { ok: problems.length === 0, problems };
}
