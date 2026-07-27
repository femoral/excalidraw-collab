---
name: excalidraw-collab
description: Read and edit Excalidraw diagrams hosted on an excalidraw-collab server with the `excalicli` CLI. Use when asked to draw, update, review, explain, or describe a diagram, architecture sketch, flowchart, or whiteboard that lives in Excalidraw, when a scene slug or `.excalidraw` file comes up, or when handing a canvas back to a human collaborator. Covers the turn loop — pull, diff, describe, edit, push, watch.
---

# excalidraw-collab

Diagrams live on a server. You edit them as JSON; a human edits the same scene in
a browser. Both sides take **turns**, and either side can ask exactly what the
other changed.

The binary is always `excalicli`. Do not invent flags or call HTTP endpoints
directly — `excalicli <command> --help` is authoritative, and the CLI already
maps exit codes, conflict diffs, and local state for you.

**Run every command from one stable project directory.** Local state
(`.excalidraw-collab/state.json`) and default scene paths are relative to the
process cwd.

## Start of session

```sh
excalicli whoami          # identity check — this name is the author on your pushes
excalicli ls              # scenes on the server
```

If `whoami` fails, stop and read [reference/setup.md](reference/setup.md).
Server config and tokens are the user's to provide — do not guess a URL or mint
credentials on your own.

## The turn loop

Do this every turn, in this order:

```sh
excalicli pull SLUG                        # writes SLUG.excalidraw, records the version
excalicli diff SLUG --since-last-pull      # what changed since your last pull/push
excalicli describe SLUG                    # read the canvas as text — you cannot see pixels
# … edit SLUG.excalidraw …
excalicli push SLUG -m "what you changed"  # message is required
```

- An empty diff is success (exit 0), not an error.
- `describe --verbose` adds element ids, for surgical edits.
- Add `--json` to any command when you will branch on the output:
  `excalicli --json diff SLUG --since-last-pull`.
- After a successful push, local state advances to the new head automatically.

Creating a scene:

```sh
excalicli new "Architecture" --slug arch
excalicli pull arch          # brand-new scene is v0 with empty elements — normal
# … write elements …
excalicli push arch -m "initial architecture"
```

## Editing the scene file

`pull` gives you a JSON document whose `elements` array is authoritative in
order. Rules:

- **Preserve existing element `id`s** when changing a shape; new shapes get new
  unique ids.
- Leave `type`, `version`, and `source` as they are.
- Skip `index` (fractional ordering) — the editor repairs it on load.
- `version`, `versionNonce`, `updated`, and `seed` are ignored by diff. Don't
  fuss over them.

For greenfield diagrams, author a **skeleton** instead of full element blobs:

```json
[
  {
    "type": "rectangle",
    "id": "api",
    "x": 0,
    "y": 0,
    "width": 180,
    "height": 80,
    "label": { "text": "API" }
  },
  {
    "type": "rectangle",
    "id": "db",
    "x": 300,
    "y": 0,
    "width": 180,
    "height": 80,
    "label": { "text": "DB" }
  },
  { "type": "arrow", "start": { "id": "api" }, "end": { "id": "db" } }
]
```

```sh
excalicli push SLUG --skeleton -m "boxes and arrow"   # reads SLUG.skeleton.json
```

Prefer skeletons when creating from scratch; prefer the full document when
editing a human's existing scene.

## Reading the canvas

| Need                                                | Command                                            |
| --------------------------------------------------- | -------------------------------------------------- |
| Structure — frames, labels, arrows as edges, groups | `excalicli describe SLUG`                          |
| Element ids alongside the outline                   | `excalicli describe SLUG --verbose`                |
| Pixel image for a vision model                      | `excalicli export SLUG --format png -o out.png`    |
| SVG / raw scene JSON                                | `excalicli export SLUG --format svg\|json -o FILE` |

**Always start with `describe`.** It is cheap and always available. Reach for
PNG only when you need layout or geometry that text cannot convey.

## Handing the turn back

After you finish, hand the canvas back and **block** — never busy-poll `diff` or
leave a streaming `watch` running forever.

```sh
excalicli push SLUG -m "agent turn done"
excalicli watch SLUG --once --timeout 900   # exit 0 = something landed, exit 6 = timeout
excalicli pull SLUG
excalicli diff SLUG --since-last-pull
excalicli describe SLUG
```

Watch flags worth knowing:

| Flag                   | Effect                                              |
| ---------------------- | --------------------------------------------------- |
| `--once`               | Exit after the first matching event                 |
| `--timeout SECONDS`    | Exit **6** after N seconds of silence               |
| `--events commit,turn` | Also wake on lock claim/release (default: `commit`) |
| `--for-turn`           | Block until the turn lock is free or held by you    |

Optional politeness — the advisory turn lock. It never blocks anyone unless
asked to:

```sh
excalicli turn claim SLUG      # exit 5 if someone else holds it
excalicli push SLUG -m "…"     # a successful push releases the lock server-side
excalicli turn release SLUG    # only if you abort without pushing
```

## Other commands

```sh
excalicli log SLUG -n 20             # version history, newest first
excalicli diff SLUG --from head~1 --to head
excalicli pull --all -o ./scenes/    # every scene head as plain .excalidraw files
```

## Exit codes

| Code | Meaning                                               |
| ---: | ----------------------------------------------------- |
|    0 | Success (including empty diffs)                       |
|    1 | Server / network / I/O failure                        |
|    2 | Bad args, missing login, or push without a prior pull |
|    4 | Push conflict — head moved                            |
|    5 | Turn lock held by someone else                        |
|    6 | `watch --timeout` elapsed                             |

Always check the exit status. **On any non-zero exit other than 6, read
[reference/troubleshooting.md](reference/troubleshooting.md)** before retrying —
especially exit 4, where the conflict diff is already printed for you and
re-running `diff` is wasted work.
