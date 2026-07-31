/**
 * scope.ts — the app's instance scope, and the staged-write guard bound to it.
 *
 * Its own file for one structural reason: `crossfilter.ts` needs `appScope` to
 * declare its durables, and `store.ts` needs the crossfilter to run a load. With
 * both living in store.ts that is a cycle; with the scope extracted the graph is
 * scope.ts <- crossfilter.ts <- store.ts and stays acyclic.
 */
import { scope } from "@habemus-papadum/aiui-viz";
import { type DurableState, durableState } from "./durable-state";

/**
 * The app's instance scope: ONE slug qualifying every declaration — controls
 * ("pdum-cc-miner/idleGapMinutes"), durable keys, cells, actions — and naming
 * the graph key and the agent toolkit. Thread it through everything you declare
 * (`control({ scope: appScope, … })`, `appScope.durable(…)`,
 * `cell(deps, compute, { scope: appScope })`, `action({ scope: appScope, … })`):
 * it is what lets this app share a document with other aiui apps — mounted in
 * a gallery shell, or composed as a library — without colliding on the
 * window-global registries. See the user guide's "Composing bigger apps".
 */
export const appScope = scope("pdum-cc-miner");

/**
 * The staged-write guard, bound to this app's scope.
 *
 * See `durable-state.ts` for why it exists: every toggle here computes its next
 * value from its current one, and a Solid 2 signal read is stale until the next
 * microtask, so rapid clicks all read the same base and only the last survives.
 */
export function scopedState<T>(key: string, initial: T): DurableState<T> {
  return durableState<T>(
    appScope.durable<{ v: T }>(`${key}:authority`, () => ({ v: initial })),
    appScope.durableSignal<T>(key, initial as never),
  );
}
