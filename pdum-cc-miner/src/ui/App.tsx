/**
 * App.tsx — the root layout (playbook layer 4: the application shell).
 *
 * Reading order is the argument the page makes: the summary strip first,
 * because the cache-read share reframes everything after it; then the session
 * graph (the shape of the work — what ran when, beside what); then every turn
 * as a dot (the other half of the crossfilter); then daily spend
 * (where and when); then attribution (what caused it); then sessions (was it
 * time well spent); and last the two drill-downs into one of them: its
 * turn-by-turn cost, and then the transcript itself. That is the whole descent
 * — corpus, project, session, turn, block.
 *
 * All but one panel are pure readers of the cell graph. The session graph is
 * the exception and deliberately so: it is a Mosaic client on the shared
 * cross-filter, so brushing a time range in it re-queries every other client
 * through the coordinator rather than through this tree.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import { graph } from "../model/graph";
import { store } from "../model/store";
import { Attribution } from "./Attribution";
import { DailySpend } from "./DailySpend";
import { ProjectFilter } from "./ProjectFilter";
import { SessionDetail } from "./SessionDetail";
import { SessionReplay } from "./SessionReplay";
import { Sessions } from "./Sessions";
import { SessionTimeline } from "./SessionTimeline";
import { SourceSwitch } from "./SourceSwitch";
import { Summary } from "./Summary";
import { TurnScatter } from "./TurnScatter";

function Loading() {
  const p = () => store.progress();
  return (
    <div class="cco-loading">
      <div class="cco-loading-label">{p().label}</div>
      <div class="cco-loading-track">
        <div
          class={`cco-loading-fill${p().fraction === null ? " cco-loading-indeterminate" : ""}`}
          style={p().fraction !== null ? { width: `${(p().fraction ?? 0) * 100}%` } : undefined}
        />
      </div>
    </div>
  );
}

/**
 * A missing corpus is the expected state of a fresh install, so it gets real
 * instructions rather than a stack trace.
 *
 * KNOWN GAP, and a feature request rather than a wording problem: production
 * builds are host-only, so this panel is also what someone who installed the
 * `.dmg` sees — and they have no checkout, no pnpm, and no `cc-assay` to run.
 * The command below is right for a developer and useless to them. Naming the
 * DIRECTORY first is what serves both: it is the one fact a packaged user can
 * act on, by pointing `PDUM_CC_MINER_CORPUS` at a corpus copied from elsewhere.
 * The real fix is running the miner from the app; until then, do not pretend
 * the command is universal.
 */
function NoData(props: { error: string }) {
  return (
    <div class="cco-nodata">
      <h2 class="cco-h2">no data yet</h2>
      <p>
        This app reads Parquet mined from your own Claude Code transcripts. It is personal telemetry
        — conversation text, project names, branch names, paths — so it is never bundled with the
        app and never leaves your machine. It is read at run time from:
      </p>
      <pre class="cco-cmd">~/.cache/cc-miner</pre>
      <p class="cco-note">Nothing is there yet. From a checkout of the repo, generate it with:</p>
      <pre class="cco-cmd">pnpm -C cc-assay mine</pre>
      <p class="cco-note">…then reload. The loader reported:</p>
      <pre class="cco-err">{props.error}</pre>
    </div>
  );
}

export function App() {
  return (
    <div class="app cco">
      <header class="cco-head">
        <div class="cco-head-row">
          <div>
            <h1 class="cco-h1">cc-miner</h1>
            <p class="cco-sub">your own Claude Code usage, and whether it was time well spent</p>
          </div>
          {/* Outside the CellView below on purpose — see SourceSwitch. */}
          <SourceSwitch />
        </div>
      </header>
      {/* The dataset cell drives the load; the page is its view. */}
      <CellView
        of={graph().dataset}
        fallback={<Loading />}
        errorFallback={(error: unknown) => <NoData error={String(error)} />}
      >
        {() => (
          <>
            <Summary />
            <ProjectFilter />
            <SessionTimeline />
            <TurnScatter />
            <DailySpend />
            <Attribution />
            <Sessions />
            <SessionDetail />
            <SessionReplay />
          </>
        )}
      </CellView>
    </div>
  );
}
