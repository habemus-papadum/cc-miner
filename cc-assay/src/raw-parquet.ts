/**
 * Writing and reading the raw layer's Parquet.
 *
 * Kept apart from `parquet.ts` (which writes the analytic grains) because the
 * two have opposite goals: that one declares every column, this one declares as
 * few as it can and puts the record in a VARIANT.
 */

import { parquetWriteFile } from "hyparquet-writer";
import type { FileRow, RawRow } from "./raw.ts";

type ColType = "STRING" | "INT64" | "VARIANT" | "DOUBLE";
interface ColumnData {
  name: string;
  data: unknown[];
  type: ColType;
}

/**
 * VARIANT and STRING take values as-is; INT64 needs BigInt (hyparquet-writer
 * rejects a plain number). A null stays null so the column stays nullable.
 */
function col<T>(name: string, rows: T[], type: ColType, pick: (r: T) => unknown): ColumnData {
  const data = rows.map((r) => {
    const v = pick(r);
    if (v === undefined) return null;
    if (type === "INT64") return v === null ? null : BigInt(Math.round(Number(v)));
    if (type === "DOUBLE") return v === null ? null : Number(v);
    return v;
  });
  return { name, data, type };
}

export const rawColumns = (rows: RawRow[]): ColumnData[] => [
  col("hostId", rows, "STRING", (r) => r.hostId),
  col("projectSlug", rows, "STRING", (r) => r.projectSlug),
  col("project", rows, "STRING", (r) => r.project),
  col("relPath", rows, "STRING", (r) => r.relPath),
  col("fileKind", rows, "STRING", (r) => r.fileKind),
  col("fileSessionId", rows, "STRING", (r) => r.fileSessionId),
  col("lineNo", rows, "INT64", (r) => r.lineNo),
  col("byteOffset", rows, "INT64", (r) => r.byteOffset),
  // The record itself. Unshredded on purpose — see raw.ts.
  col("rec", rows, "VARIANT", (r) => r.rec),
  col("rawText", rows, "STRING", (r) => r.rawText),
];

export const fileColumns = (rows: FileRow[]): ColumnData[] => [
  col("hostId", rows, "STRING", (r) => r.hostId),
  col("projectSlug", rows, "STRING", (r) => r.projectSlug),
  col("project", rows, "STRING", (r) => r.project),
  col("relPath", rows, "STRING", (r) => r.relPath),
  col("fileKind", rows, "STRING", (r) => r.fileKind),
  col("ext", rows, "STRING", (r) => r.ext),
  col("bytes", rows, "INT64", (r) => r.bytes),
  col("mtimeMs", rows, "INT64", (r) => r.mtimeMs),
  col("sha256", rows, "STRING", (r) => r.sha256),
  col("lines", rows, "INT64", (r) => r.lines),
  col("createdMs", rows, "INT64", (r) => r.createdMs),
  col("text", rows, "STRING", (r) => r.text),
];

export function writeRaw(
  dir: string,
  raw: RawRow[],
  files: FileRow[],
  join: (...p: string[]) => string,
): void {
  parquetWriteFile({ filename: join(dir, "raw.parquet"), columnData: rawColumns(raw) as never });
  parquetWriteFile({
    filename: join(dir, "files.parquet"),
    columnData: fileColumns(files) as never,
  });
}
