/**
 * The staged-write hazard, reproduced against a signal that behaves like Solid
 * 2's — reads return the last COMMITTED value until a flush.
 *
 * These tests fail against a plain `set(f(get()))` toggle and pass against
 * `set(f(peek()))`, which is the whole point: the bug is invisible unless two
 * writes land before a flush, and a test that clicks slowly never sees it.
 */

import { describe, expect, it } from "vitest";
import { durableState, toggled } from "./durable-state";

/** A signal with Solid 2's staging semantics: `get()` is stale until flush. */
function stagedSignal<T>(initial: T) {
  let committed = initial;
  let staged = initial;
  let dirty = false;
  return {
    get: () => committed,
    set: (next: never) => {
      staged = next as T;
      dirty = true;
    },
    flush: () => {
      if (dirty) committed = staged;
      dirty = false;
    },
  };
}

describe("durableState", () => {
  it("peek() sees a write that get() cannot yet", () => {
    const box = { v: 1 };
    const sig = stagedSignal(1);
    const s = durableState<number>(box, sig);

    s.set(2);
    expect(s.peek()).toBe(2); // authority: current
    expect(s.get()).toBe(1); // mirror: still the committed value
    sig.flush();
    expect(s.get()).toBe(2);
  });

  it("keeps every write when several land before a flush", () => {
    // The real failure: eight chips clicked in one tick left one deselected,
    // because each handler read the same committed base.
    const box = { v: new Set<string>() as ReadonlySet<string> };
    const sig = stagedSignal<ReadonlySet<string>>(new Set());
    const s = durableState<ReadonlySet<string>>(box, sig);

    for (const k of ["a", "b", "c", "d"]) s.set(toggled(s.peek(), k));
    sig.flush();
    expect([...s.get()].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("loses all but the last write if the reactive read is used instead", () => {
    // The bug, pinned. If this ever starts passing with four entries, the
    // signal has stopped staging and the guard above is no longer needed.
    const box = { v: new Set<string>() as ReadonlySet<string> };
    const sig = stagedSignal<ReadonlySet<string>>(new Set());
    const s = durableState<ReadonlySet<string>>(box, sig);

    for (const k of ["a", "b", "c", "d"]) s.set(toggled(s.get(), k));
    sig.flush();
    expect([...s.get()]).toEqual(["d"]);
  });

  it("advances a counter once per call, not once per flush", () => {
    // The silent version: two crossfilter clauses in one tick both read the
    // same version, both write it, and no filter-keyed panel recomputes.
    const box = { v: 0 };
    const sig = stagedSignal(0);
    const s = durableState<number>(box, sig);

    s.set(s.peek() + 1);
    s.set(s.peek() + 1);
    sig.flush();
    expect(s.get()).toBe(2);
  });

  it("round-trips a toggle", () => {
    const box = { v: new Set(["x"]) as ReadonlySet<string> };
    const sig = stagedSignal<ReadonlySet<string>>(new Set(["x"]));
    const s = durableState<ReadonlySet<string>>(box, sig);

    s.set(toggled(s.peek(), "x"));
    expect([...s.peek()]).toEqual([]);
    s.set(toggled(s.peek(), "x"));
    expect([...s.peek()]).toEqual(["x"]);
  });
});

describe("toggled", () => {
  it("adds what is absent and removes what is present, without mutating", () => {
    const a = new Set(["x"]);
    const b = toggled(a, "y");
    expect([...a]).toEqual(["x"]); // untouched — Solid compares by identity
    expect([...b].sort()).toEqual(["x", "y"]);
    expect([...toggled(b, "x")]).toEqual(["y"]);
  });
});
