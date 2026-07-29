/**
 * rows.ts — the one place a database row becomes a plain JS object.
 *
 * ## Why this is a module and not three lines inline
 *
 * The values that come back depend on *who decoded them*, and that changes when
 * the execution seam moves (see docs/proposals/deployment-shapes.md §2.1):
 *
 * | column type | duckdb-wasm (apache-arrow) | Mosaic (flechette) |
 * | --- | --- | --- |
 * | `BIGINT` | `BigInt` | `BigInt` |
 * | `TIMESTAMP` | `BigInt` (epoch ms) | **`Date`** |
 * | `DOUBLE` | `number` | `number` |
 *
 * Routing `store.sql()` through the coordinator changed the second column to the
 * third, and a `SELECT ts` that had returned `1781879709507` began returning a
 * `Date`. Nothing in this app broke, because every query wraps timestamps in
 * `epoch_ms()` — but that is a convention holding by luck, and spike 1 recorded
 * the same class of change (TIMESTAMP encoded as float64) producing
 * `RangeError: Invalid time value` from four unrelated components with no error
 * at the source.
 *
 * So the contract is stated here and asserted by tests: **BigInt and Date both
 * become epoch-millisecond numbers**, because that is what every consumer in
 * this app already assumes. When a socket connector lands with its own Arrow
 * encoding, this is the single place that has to agree with it.
 */

/**
 * Coerce one row to plain JS values.
 *
 * Mutates and returns the same object — these rows are freshly decoded per
 * query and never shared, and copying 30,420 of them per scatter render is
 * measurable where this is not.
 */
export function plainRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const k in row) {
    const v = row[k];
    // BigInt poisons arithmetic and `new Date()` ("Cannot convert a BigInt
    // value to a number"). Token counts and epoch ms are both far inside
    // Number's exact-integer range, so nothing is lost.
    if (typeof v === "bigint") row[k] = Number(v);
    // A Date is not wrong, just not what this app speaks. Every cell and chart
    // here works in epoch milliseconds.
    else if (v instanceof Date) row[k] = v.getTime();
  }
  return row;
}
