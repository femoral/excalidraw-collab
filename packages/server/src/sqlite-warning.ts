/**
 * `node:sqlite` is still flagged experimental in some Node versions.
 * Install a process-wide filter so the warning never pollutes CLI/JSON stdout.
 *
 * Import this module before `node:sqlite` is first loaded (db.ts does that).
 */

const SQLITE_EXPERIMENTAL = /node:sqlite|sqlite module/i;

function isSqliteExperimentalWarning(warning: string | Error, ...rest: unknown[]): boolean {
  const message =
    typeof warning === "string"
      ? warning
      : warning instanceof Error
        ? warning.message
        : String(warning);
  const name =
    typeof warning === "object" &&
    warning !== null &&
    "name" in warning &&
    typeof (warning as { name: unknown }).name === "string"
      ? (warning as { name: string }).name
      : typeof rest[0] === "string"
        ? rest[0]
        : "";
  const type = typeof rest[0] === "string" ? rest[0] : typeof rest[1] === "string" ? rest[1] : "";

  if (!SQLITE_EXPERIMENTAL.test(message) && !SQLITE_EXPERIMENTAL.test(name)) {
    return false;
  }
  return (
    name === "ExperimentalWarning" ||
    type === "ExperimentalWarning" ||
    /ExperimentalWarning/i.test(message)
  );
}

const originalEmitWarning = process.emitWarning.bind(process);

// Overwrite once; subsequent imports are no-ops for the filter install.
if (!(process.emitWarning as { __sqliteFiltered?: boolean }).__sqliteFiltered) {
  const filtered: typeof process.emitWarning & {
    __sqliteFiltered?: boolean;
  } = ((warning: string | Error, ...args: unknown[]) => {
    if (isSqliteExperimentalWarning(warning, ...args)) {
      return;
    }
    // process.emitWarning has several overloads; forward as-is.
    return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning & { __sqliteFiltered?: boolean };

  filtered.__sqliteFiltered = true;
  process.emitWarning = filtered;
}

export {};
