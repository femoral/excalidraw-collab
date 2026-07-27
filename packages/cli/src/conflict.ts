/**
 * Render a 409 conflict body for humans / agents.
 *
 * The server already embeds the parent→head structured diff in the same
 * response — we never call GET /diff. Rendering is pure field formatting
 * (same idea as core's formatDiff) with zero runtime deps.
 */

/** Minimal SceneDiff shape from the server conflict body. */
export type ConflictDiff = {
  from?: number;
  to?: number;
  summary?: {
    added?: number;
    deleted?: number;
    updated?: number;
    reordered?: number;
  };
  elements?: Array<
    | { op: "add" | "delete" | "update"; describe?: string; [k: string]: unknown }
    | {
        op: "reorder";
        type?: string;
        label?: string | null;
        from?: number;
        to?: number;
        [k: string]: unknown;
      }
    | { op?: string; describe?: string; [k: string]: unknown }
  >;
  appState?: Array<{ key: string; from: unknown; to: unknown }>;
};

export type ConflictDetails = {
  code?: string;
  head?: number;
  parentVersion?: number;
  diff?: ConflictDiff;
};

export function resolutionCommands(
  slug: string,
  message?: string,
): string[] {
  const m =
    message && message.trim().length > 0
      ? JSON.stringify(message.trim())
      : '"your message"';
  return [
    `excalicli pull ${slug}`,
    `excalicli push ${slug} -m ${m}`,
    `excalicli push ${slug} -m ${m} --force`,
  ];
}

/** Plain-text rendering of a structured SceneDiff (no second HTTP request). */
export function formatConflictDiff(diff: ConflictDiff | undefined): string {
  if (!diff) {
    return "(no diff in conflict response)\n";
  }

  const summary = diff.summary ?? {
    added: 0,
    deleted: 0,
    updated: 0,
    reordered: 0,
  };
  const counts: string[] = [];
  if (summary.added) counts.push(`+${summary.added}`);
  if (summary.deleted) counts.push(`-${summary.deleted}`);
  if (summary.updated) counts.push(`~${summary.updated}`);
  if (summary.reordered) counts.push(`↕${summary.reordered}`);
  const countStr = counts.length > 0 ? counts.join(" ") : "(empty)";

  const hasVersions = diff.from !== undefined && diff.to !== undefined;
  const header = hasVersions
    ? `v${diff.from} → v${diff.to}   ${countStr}`
    : countStr;

  const lines: string[] = [header];

  for (const change of diff.elements ?? []) {
    if (
      change &&
      typeof change === "object" &&
      "op" in change &&
      change.op === "reorder"
    ) {
      const type = typeof change.type === "string" ? change.type : "element";
      const label =
        typeof change.label === "string" && change.label.length > 0
          ? ` "${change.label}"`
          : "";
      lines.push(
        `↕ ${type}${label}  ${change.from ?? "?"} → ${change.to ?? "?"}`,
      );
    } else if (
      change &&
      typeof change === "object" &&
      typeof change.describe === "string"
    ) {
      lines.push(change.describe);
    }
  }

  if (diff.appState && diff.appState.length > 0) {
    lines.push("appState:");
    for (const p of diff.appState) {
      lines.push(
        `  ${p.key}: ${formatAppStateValue(p.from)} → ${formatAppStateValue(p.to)}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Render one side of an appState delta. Absent keys arrive as JS `undefined`
 * (JSON.stringify(undefined) is the bare word "undefined" in a template string);
 * surface that as an explicit "(unset)" for humans and LLMs.
 */
export function formatAppStateValue(value: unknown): string {
  if (value === undefined) {
    return "(unset)";
  }
  return JSON.stringify(value);
}

/**
 * Full multi-line conflict message for stderr / CliError.message, including
 * the exact next commands an agent should run.
 */
export function formatConflictMessage(
  slug: string,
  details: ConflictDetails | undefined,
  opts: { message?: string; serverMessage?: string } = {},
): string {
  const head = details?.head;
  const parent = details?.parentVersion;
  const title =
    opts.serverMessage && opts.serverMessage.length > 0
      ? opts.serverMessage
      : parent !== undefined && head !== undefined
        ? `Conflict: parentVersion ${parent} does not match head ${head}`
        : "Conflict: parentVersion does not match head";

  const diffText = formatConflictDiff(details?.diff);
  const cmds = resolutionCommands(slug, opts.message);

  const lines = [
    title,
    "",
    "What you missed (parent → head):",
    diffText.trimEnd(),
    "",
    "Nothing was changed on the server.",
    "",
    "To resolve, run exactly:",
    `  1. ${cmds[0]}                  # refresh local file + state to head`,
    `  2. # re-apply your edits to the file`,
    `  3. ${cmds[1]}   # retry`,
    `  # or take the server head as yours:`,
    `  ${cmds[2]}`,
    "",
  ];
  return lines.join("\n");
}
