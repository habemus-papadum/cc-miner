/**
 * The decode boundary. These assertions exist because the values crossing it
 * change when the execution seam moves, and the change is silent — see rows.ts.
 */

import { describe, expect, it } from "vitest";
import { plainRow } from "./rows";

describe("plainRow", () => {
  it("turns BigInt into number", () => {
    // DuckDB hands INT64/HUGEINT back as BigInt, which throws on `new Date()`
    // and on any arithmetic mixing it with a number.
    expect(plainRow({ n: 30420n })).toEqual({ n: 30420 });
  });

  it("turns Date into epoch milliseconds", () => {
    // The one that changed under the coordinator: flechette decodes TIMESTAMP
    // to Date where duckdb-wasm gave BigInt. Both must land on the same number.
    const ms = 1781879709507;
    expect(plainRow({ ts: new Date(ms) })).toEqual({ ts: ms });
  });

  it("agrees on a timestamp however it was decoded", () => {
    // The actual contract: the two decoders must be indistinguishable
    // downstream. This is the assertion a socket connector has to keep passing.
    const ms = 1781879709507;
    expect(plainRow({ ts: BigInt(ms) }).ts).toBe(plainRow({ ts: new Date(ms) }).ts);
  });

  it("leaves everything else alone", () => {
    const row = { s: "pdum_aiui", d: 11384.530895, b: true, nul: null, u: undefined };
    expect(plainRow({ ...row })).toEqual(row);
  });

  it("does not touch nested values", () => {
    // Deliberate: no query in this app selects a nested column, and recursing
    // would cost a walk per row on a 30,420-row scatter. If that changes, this
    // test is the place it gets noticed.
    const nested = { at: new Date(0) };
    expect(plainRow({ nested }).nested).toBe(nested);
  });

  it("is safe on an empty row", () => {
    expect(plainRow({})).toEqual({});
  });
});
