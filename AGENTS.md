# Agent guide — excalidraw-collab

Self-hosted Excalidraw with server-side versions and a CLI (`excalicli`) built for
AI agents. You draw by editing JSON (or short skeletons); humans draw in the
browser; both sides take **turns** and can see exactly what the other changed.

This file is the contract. Follow it without inventing flags or endpoints.
Full flag text for every command: [docs/cli.md](./docs/cli.md) (generated from
the CLI parsers — if it disagrees with a `--help` line, trust the CLI).

---

## Prerequisites

1. A running server (see [README.md](./README.md) quickstart).
2. A bearer token (admin bootstrap token, or one minted with `excalicli token create`).
3. The CLI built and on your `PATH`, **or** invoked from this repo after `pnpm build`:

```sh
# From the monorepo root, after pnpm install && pnpm build:
node packages/cli/bin/excalicli --help
# or, if the package bin is linked:
pnpm --filter @excalidraw-collab/cli exec excalicli --help
```

Binary name is always **`excalicli`**.

---

## Auth and local state

### Login (once per machine / agent identity)

```sh
excalicli login --server http://HOST:PORT --token YOUR_TOKEN
```

- `YOUR_TOKEN` is either the server's `BOOTSTRAP_TOKEN` (admin, first boot) or a
  named token from `excalicli token create NAME` (needs an admin token to mint).
- Writes `~/.config/excalicli/config.json` (mode `0600`), or
  `$XDG_CONFIG_HOME/excalicli/config.json`.

Overrides (win over the file):

| Env var | Purpose |
|---|---|
| `EXCALICLI_SERVER` | Base URL (no trailing slash required) |
| `EXCALICLI_TOKEN` | Bearer token |

Check identity (this name is the `author` on every version you push):

```sh
excalicli whoami
excalicli whoami --json
```

### Working-directory state

**Always run the turn loop from one stable project directory.** Local state and
default scene files are relative to the process cwd.

Path: **`.excalidraw-collab/state.json`** under that directory.

Records the last successfully **pulled or pushed** version per scene, per server.
This is what makes `diff --since-last-pull` and safe `push` work. Do not invent
version numbers by hand — pull/push update the file for you.

Default scene files in the cwd:

| Mode | Default path |
|---|---|
| Full document | `<slug>.excalidraw` |
| Skeleton (`push --skeleton`) | `<slug>.skeleton.json` |

A brand-new scene (`excalicli new …`) has head **v0** and an empty `elements`
array after pull — that is normal. Write elements, then push.

---

## The turn loop (do this every time)

```
pull → diff --since-last-pull → describe → edit file → push -m "…"
```

Concrete commands (replace `SLUG` with the scene slug, e.g. `arch`):

```sh
# 1. Fetch head into SLUG.excalidraw and record the version in local state
excalicli pull SLUG

# 2. See what changed since your last pull/push (empty = nothing new; still exit 0)
excalicli diff SLUG --since-last-pull
# Prefer machine-readable when parsing:
excalicli --json diff SLUG --since-last-pull

# 3. Understand the current canvas as text (you cannot see pixels)
excalicli describe SLUG
excalicli describe SLUG --verbose    # include element ids

# 4. Edit SLUG.excalidraw (or write a skeleton — see below)
#    Keep element `id`s stable when updating existing shapes.

# 5. Commit a new version (message is required)
excalicli push SLUG -m "short summary of your turn"
```

Optional politeness (never hard-blocks unless you ask it to):

```sh
excalicli turn claim SLUG          # advisory lock; exit 5 if someone else holds it
# … work …
excalicli push SLUG -m "…"         # successful push auto-releases the lock server-side
excalicli turn release SLUG        # if you abort without pushing
```

`push --respect-lock` exits **5** when another holder has the lock; without that
flag, a held lock only prints a warning on stderr.

### Creating a scene

```sh
excalicli new "Architecture" --slug arch
excalicli pull arch
# edit arch.excalidraw
excalicli push arch -m "initial architecture"
```

List scenes: `excalicli ls` / `excalicli --json ls`.

---

## Conflict handling (exit 4)

Every push sends `parentVersion` from `.excalidraw-collab/state.json`. If head
moved, the server responds **409 Conflict** with the **parent→head diff already
in the body**. The CLI exits **4** and prints that diff — **do not call `diff`
again to discover what you missed**.

With `--json`, stdout is one error envelope:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "…",
    "details": {
      "head": 12,
      "parentVersion": 10,
      "diff": { "from": 10, "to": 12, "summary": { "…": 0 }, "elements": [] },
      "resolution": [
        "excalicli pull SLUG",
        "excalicli push SLUG -m \"…\"",
        "excalicli push SLUG -m \"…\" --merge",
        "excalicli push SLUG -m \"…\" --force"
      ]
    }
  }
}
```

### Resolve

| Strategy | Command | When |
|---|---|---|
| Rebase yourself | `pull`, re-apply edits, `push -m "…"` | **Default; safest for agents** |
| Server merge | `push SLUG -m "…" --merge` | Overlapping edits; needs `RENDER_WORKER=on` |
| Overwrite head | `push SLUG -m "…" --force` | Your version must win; rare |

`--force` and `--merge` are mutually exclusive.

If `--merge` fails with exit **1** and a message that `RENDER_WORKER=off` (or
Playwright is missing), do **not** invent a client-side merge. Fall back to
pull → re-apply → push, or `--force` only when overwriting is intentional.

After any successful push, local state advances to the new head automatically.

---

## Waiting for the human

After you finish a turn, hand the canvas back and **block** until the human
acts — do not busy-poll `diff` or leave a streaming `watch` running forever.

```sh
excalicli push SLUG -m "agent turn done"
excalicli turn release SLUG          # free the advisory lock if you held it
# Park until the first new commit (or use --for-turn to wait for the lock):
excalicli watch SLUG --once --timeout 900
# exit 0 → something landed; exit 6 TIMEOUT → human walked away
excalicli pull SLUG
excalicli diff SLUG --since-last-pull
excalicli describe SLUG
# … edit, then push again
```

Useful variants:

| Flag | Effect |
|---|---|
| `--once` | Exit 0 after the first matching event (one diff / one JSONL line) |
| `--timeout SECONDS` | Exit **6** (`TIMEOUT`) after N seconds of silence; under `--json` emits `{"timeout":true,"slug":…}` |
| `--events commit,turn` | Also wake on lock claim/release/TTL expiry (default is `commit` only) |
| `--for-turn` | Block until the lock is free or held by this token, then exit 0 |

Default flagless `watch` still streams until Ctrl-C — same as before.

---

## `describe` vs `export --format png`

| Need | Command | Requires render worker? |
|---|---|---|
| Structure: frames, labels, arrows as edges, groups | `excalicli describe SLUG` | **No** — always works |
| Pixel image for a vision model | `excalicli export SLUG --format png -o out.png` | **Yes** (`RENDER_WORKER=on`) |
| SVG | `excalicli export SLUG --format svg -o out.svg` | Yes |
| Raw scene JSON (same family as pull) | `excalicli export SLUG --format json -o out.excalidraw` | No |

Rules of thumb:

- **Always start with `describe`** (and `diff --since-last-pull`). Cheap and reliable.
- Use **PNG only** when you need layout/geometry that text cannot convey and the
  server has the render worker. If export fails with “not available”, fall back
  to `describe` — do not invent a second render path.
- `describe --verbose` when you must correlate outline lines with element `id`s
  for surgical JSON edits.

---

## Editing the scene file

### Full `.excalidraw` document

After `pull`, you have a JSON object with at least:

- `type`: `"excalidraw"`
- `version`, `source` (keep as-is unless you know better)
- `elements`: array — **array order is authoritative**
- `appState`: only whitelisted keys are stored server-side; viewer noise is stripped
- `files`: map of embedded images (content-addressed)

**Preserve existing element `id`s** when you change a shape. New elements need
new unique ids. You do **not** need fractional `index` fields — the editor
repairs ordering on load.

Ignored on diff (do not stress over them): `version`, `versionNonce`, `updated`, `seed`.

### Skeleton authoring (`push --skeleton`)

When you are creating shapes from scratch and do not want full element blobs:

```json
[
  { "type": "rectangle", "id": "api", "x": 0, "y": 0, "width": 180, "height": 80,
    "label": { "text": "API" } },
  { "type": "rectangle", "id": "db", "x": 300, "y": 0, "width": 180, "height": 80,
    "label": { "text": "DB" } },
  { "type": "arrow", "start": { "id": "api" }, "end": { "id": "db" } }
]
```

```sh
# writes default SLUG.skeleton.json if -f omitted
excalicli push SLUG --skeleton -m "boxes and arrow"
```

Also accepts `{ "elements": [ … ] }`. Requires `RENDER_WORKER=on` (server runs
upstream `convertToExcalidrawElements`). Prefer skeletons for greenfield diagrams;
prefer full documents when editing a human's existing scene.

---

## Exit codes (every command)

| Code | Constant | Meaning |
|---:|---|---|
| **0** | OK | Success. Empty diffs are success. |
| **1** | ERROR | Server/network/internal failure, not found, etc. |
| **2** | USAGE | Bad CLI args, missing login, or push without a prior pull when head is already greater than 0 |
| **4** | CONFLICT | Push rejected; read the conflict diff in the message / `--json` body |
| **5** | LOCK_HELD | `turn claim` denied, or `push --respect-lock` while another holder is active |
| **6** | TIMEOUT | `watch --timeout` elapsed with no matching event |

Always check `$?` (or your runtime's exit status). Prefer `--json` when you will
branch on outcomes — failures still put one JSON object on **stdout** and a
human line on **stderr**.

---

## Other useful commands

```sh
excalicli log SLUG                 # version history (newest first)
excalicli log SLUG -n 20
excalicli diff SLUG --from head~1 --to head
excalicli watch SLUG               # long-poll; prints each new diff (JSONL with --json)
excalicli watch SLUG --once --timeout 900   # block until one event or timeout (exit 6)
excalicli watch SLUG --for-turn    # block until lock free or held by me
excalicli pull --all -o ./scenes/  # every scene head as plain .excalidraw files
excalicli backup -o backup.tar.gz  # admin: full portable archive
excalicli restore backup.tar.gz    # admin: restore (see --on-collision)
excalicli token create agent-name  # admin: mint a named token (printed once)
excalicli token ls
excalicli token revoke agent-name
```

---

## What not to do

- Do not call HTTP endpoints directly unless the CLI cannot express the action —
  the CLI already maps exit codes, conflict diffs, and local state.
- Do not skip `pull` before editing a scene that already has versions (unless
  `push --force` is intentional).
- Do not use `--force` to “fix” a conflict you have not read.
- Do not commit tokens, bootstrap secrets, or host-specific paths into the repo.
- Do not hand-edit `docs/cli.md` — regenerate it (see that file's header).

---

## One-screen checklist

```sh
excalicli whoami
excalicli ls
excalicli pull SLUG
excalicli diff SLUG --since-last-pull
excalicli describe SLUG
# edit SLUG.excalidraw  (stable ids)
excalicli push SLUG -m "what you changed"
# if exit 4: read the printed diff → pull / --merge / --force → retry
```
