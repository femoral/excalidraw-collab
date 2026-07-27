/**
 * Rendering helpers. Commands never write to stdout/stderr themselves —
 * they return a {@link CommandResult}; the dispatcher calls these.
 */

/** Successful command payload. Dispatcher owns all stream I/O. */
export type CommandResult = {
  /**
   * Structured value emitted under `--json` as exactly one JSON value
   * (pretty-printed object/array/etc.).
   */
  data: unknown;
  /**
   * Human-readable text for non-JSON mode. If omitted, a default table/text
   * rendering of `data` is used.
   */
  human?: string;
  /**
   * Optional non-fatal diagnostic written to stderr on success (e.g. advisory
   * lock held by someone else during push). Never mixed into the JSON data
   * channel — agents that care read `data.lockWarning` (or similar) instead.
   */
  warning?: string;
};

/** Format a list of row objects as a simple aligned table. */
export function formatTable(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns?: readonly string[],
): string {
  if (rows.length === 0) {
    return "(empty)\n";
  }
  const cols =
    columns && columns.length > 0
      ? [...columns]
      : Object.keys(rows[0] ?? {});
  if (cols.length === 0) {
    return "(empty)\n";
  }

  const stringify = (v: unknown): string => {
    if (v === null || v === undefined) {
      return "";
    }
    if (typeof v === "string") {
      return v;
    }
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
      return String(v);
    }
    return JSON.stringify(v);
  };

  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => stringify(r[c]).length)),
  );

  const pad = (s: string, w: number) => s.padEnd(w, " ");
  const line = (cells: string[]) =>
    cells.map((cell, i) => pad(cell, widths[i] ?? 0)).join("  ");

  const header = line(cols);
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows.map((r) => line(cols.map((c) => stringify(r[c]))));
  return [header, sep, ...body].join("\n") + "\n";
}

/** Default human rendering when a command does not supply `human`. */
export function formatHuman(data: unknown): string {
  if (data === null || data === undefined) {
    return "";
  }
  if (typeof data === "string") {
    return data.endsWith("\n") ? data : `${data}\n`;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return "(empty)\n";
    }
    if (data.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) {
      return formatTable(data as Record<string, unknown>[]);
    }
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    // Single-level key/value object → two-column table
    if (keys.every((k) => {
      const v = obj[k];
      return (
        v === null ||
        v === undefined ||
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      );
    })) {
      return formatTable(
        keys.map((k) => ({ key: k, value: obj[k] })),
        ["key", "value"],
      );
    }
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Exactly one JSON value on a single write (no partial output). */
export function formatJson(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}
