# `@habemus-papadum/cc-assay`

Reader, normalizer and Parquet writer for **Claude Code session transcripts**.
Internal, never published — the pure-model half of `apps/cc-miner`, in the same
relation `demos/optics` has to the wave-optics notebooks.

```sh
pnpm -C apps/cc-assay normalize                              # → ./out
pnpm -C apps/cc-assay normalize -- --out ../cc-miner/src/data  # feed the demo
pnpm -C apps/cc-assay normalize -- --offline --no-images
```

## What it does

`~/.claude/projects/**/*.jsonl` → eight Parquet tables:

| table | grain |
| --- | --- |
| `turns` | one row per **deduped API response** — the fact table |
| `toolCalls` | one row per tool_use, joined to its result |
| `events` | compaction / fallback / refusal / relocation, payload as JSON |
| `sessions` | one row per session **file**, with its place in the fork forest |
| `forkEdges` | one row per parent→child fork, with both endpoints in time |
| `lineages` | one row per fork family — the unit a human means by "a session" |
| `agentRuns` | one row per subagent / workflow-agent instance, with its span |
| `images` | one row per image payload, with estimated tokens |

Plus `manifest.json`: which price table produced the numbers, the corpus stats,
and the invariant results.

## Why it exists

`src/fields.ts` is the point of the package: the schema knowledge, encoded as
lenient accessors plus a `TRAPS` registry. Reading is total and never throws
(Claude Code shipped 28 builds in the five weeks of the baseline corpus — a
validating parser would have broken repeatedly); *noticing* drift is a separate
offline job, `exploration/cc-usage/{census,diff}.mjs`.

The traps that decide the design, each pinned by a test in `normalize.test.ts`:

- **One API response is written as one record per content block**, each
  repeating the full `message.usage`. Naive sums overstate output tokens by
  237%. Dedup for *billing* — but union the content, because the blocks are
  partitioned across those same records.
- **Forking copies the transcript prefix** into the new session's file, so one
  billed turn exists in several files (5.5% of `message.id`s). Only a corpus-wide
  dedup is correct. `session_id` (≠ `sessionId`) marks the copies, from Claude
  Code 2.1.199 onward.
- **`session_id` marks a *link*, not a copy.** 2.1.220 also continues a session
  into a fresh file with the marker on every record and not one shared uuid.
  Believing it there hands a whole session's spend to its predecessor — so
  `lineage.ts` verifies every marker against the named file's own uuids.
- **There is no cost field.** Every dollar is derived and stamped with
  `pricingVersion`.
- **Model fallback** hides the discarded attempt outside
  `message.usage.iterations[]`.

`checkInvariants()` asserts `SUM(sessions.nativeCost) === SUM(turns.costTotal)`
and that no billing key survived twice; the CLI runs it every time and exits
non-zero on failure.

## Fork lineage (`src/lineage.ts`)

A session file is not a session. `lineage.ts` recovers the forest — who forked
from whom, where in the parent's timeline, and how much context came along:

- The parent is chosen by the **longest leading-uuid run**, because in a chain
  `root → P → B` the child matches more of `P` than of `root`. The marker only
  ever names *an* ancestor, and after a fork of a fork it names the grandparent
  (the intervening records are `system`/`user` types that carry no `session_id`).
- Direction comes from **shape**: in the child the shared records are a leading
  prefix by construction; in the parent they usually are not, and only an
  original can look like that. When both look identical, **file birthtime**
  breaks the tie and the edge is flagged `ambiguous` — the one place this package
  reads filesystem metadata, and it never decides anything silently.
- `forkPointTs` is in the **parent's** timeline; `childFirstNativeTs` /
  `createdTs` are in the child's. They can be days apart, and both are needed to
  draw the edge.
- Edges with no shared records are `kind = 'continuation'`; they leave the
  parent's end rather than its middle.

What it will not do is guess. A fork whose parent is not in the corpus, or two
files that content cannot tell apart with no birthtime to break the tie, come
out as a gap plus a reason — a lineage drawn confidently wrong is worse than one
that admits it does not know.

## Pricing

LiteLLM's `model_prices_and_context_window.json`, cached under `.cache/`.
Deliberately **not** `@pydantic/genai-prices` (which this repo uses elsewhere):
it models cache writes as one bucket, and Anthropic's 1-hour cache tier costs
1.6× the 5-minute one — 54.8% of cache-creation tokens here, so flat-rating
understates total spend by 6.9%. See `src/pricing.ts` and the proposal, §3.

Full design: [`docs/proposals/claude-code-usage-analytics.md`](../../docs/proposals/claude-code-usage-analytics.md).
