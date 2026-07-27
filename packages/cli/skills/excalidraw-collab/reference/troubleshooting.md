# Troubleshooting

**Read the section matching the exit code you actually got.** Exit 0 and exit 6
(`watch --timeout`) are normal outcomes and need nothing from this file.

Under `--json`, every failure puts exactly one error envelope on **stdout** and a
human line on **stderr**:

```json
{ "error": { "code": "…", "message": "…", "details": {} } }
```

## Exit 4 — CONFLICT (push rejected)

Head moved while you were editing. Every push sends `parentVersion` from local
state; the server answered 409.

**The parent→head diff is already in the error body.** Do not run `diff` again
to find out what you missed — read what was printed.

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "…",
    "details": {
      "head": 12,
      "parentVersion": 10,
      "diff": { "from": 10, "to": 12, "summary": {}, "elements": [] },
      "resolution": ["…"]
    }
  }
}
```

Resolve:

| Strategy        | Command                                    | When                                       |
| --------------- | ------------------------------------------ | ------------------------------------------ |
| Rebase yourself | `pull`, re-apply your edits, `push -m "…"` | **Default — safest**                       |
| Server merge    | `push SLUG -m "…" --merge`                 | Overlapping edits; needs the render worker |
| Overwrite head  | `push SLUG -m "…" --force`                 | Your version must win; rare                |

`--force` and `--merge` are mutually exclusive. Never use `--force` to paper
over a conflict you have not read.

If `--merge` fails with exit 1 and a message about `RENDER_WORKER=off` or a
missing Playwright install, fall back to pull → re-apply → push. Do not invent a
client-side merge.

## Exit 5 — LOCK_HELD

Someone else holds the advisory turn lock.

- From `turn claim`: the message names the holder and the expiry. Wait with
  `excalicli watch SLUG --for-turn`, or proceed anyway — the lock is advisory
  and does not block `push`.
- From `push --respect-lock`: drop the flag to push regardless, or wait.
- A stale lock from a crashed agent can be cleared by anyone:
  `excalicli turn release SLUG`. Locks also expire on their own TTL.

## Exit 2 — USAGE

One of:

- **Bad arguments.** Check `excalicli <command> --help`; do not guess flags.
- **No server/token configured.** See [setup.md](setup.md).
- **Push without a prior pull** when head is already past v0. Run
  `excalicli pull SLUG` first, re-apply your edits, then push.

## Exit 1 — ERROR

Server, network, or I/O failure — including "scene not found".

- Confirm the slug with `excalicli ls`.
- Confirm connectivity and identity with `excalicli whoami`.
- If a feature reports it is unavailable (`export --format png`,
  `push --skeleton`, `push --merge`), the server's render worker is off. Use the
  text path instead: `describe` for reading, a full-document push for writing.
  See the capability table in [setup.md](setup.md).

## Things that look like bugs but are not

- **Empty diff, exit 0.** Nothing changed since your last pull or push. Success.
- **New scene has v0 and no elements after `pull`.** Expected. Write elements
  and push.
- **Diff ignores `version`, `versionNonce`, `updated`, `seed`.** By design.
- **Elements lack fractional `index` fields.** By design — the editor repairs
  ordering on load.
- **`push` warns that someone holds the lock but succeeds.** The lock is
  advisory; only `--respect-lock` turns it into a failure.
- **`appState` came back smaller than you wrote it.** Only whitelisted keys are
  stored server-side; viewer noise is stripped.

## Never do this

- Call HTTP endpoints directly because a command seemed to misbehave — the CLI
  owns exit-code mapping, conflict diffs, and local state.
- Hand-edit `.excalidraw-collab/state.json` or invent version numbers.
- Busy-poll `diff` in a loop while waiting for a human. Use
  `excalicli watch SLUG --once --timeout SECONDS`.
- Commit tokens, bootstrap secrets, or absolute host paths into a repository.
