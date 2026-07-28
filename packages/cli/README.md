# @excalidraw-collab/cli

`excali` — the command-line client for
[excalidraw-collab](https://github.com/femoral/excalidraw-collab): self-hosted
Excalidraw with server-side persistence, turn-based collaboration, and a CLI
built for AI agents.

## Install

```sh
npm install -g @excalidraw-collab/cli
# or: pnpm add -g @excalidraw-collab/cli
```

Requires Node 24+. Installs a single binary: `excali`.

Run it without installing:

```sh
npx @excalidraw-collab/cli --help
```

## Quick start

Point the CLI at a running excalidraw-collab server (see the
[repo README](https://github.com/femoral/excalidraw-collab#readme) for
`docker compose` setup) and log in with a token:

```sh
excali login --server https://excali.example.com --token "$TOKEN"
excali whoami

excali new "Architecture" --slug arch
excali pull arch                       # writes arch.excalidraw
# edit the file, or open the scene in a browser
excali push arch -m "initial diagram"

excali describe arch                   # text summary of the scene
excali diff arch --since-last-pull     # what changed since your last pull
excali watch arch                      # block until someone else's turn lands
```

## Agent skill

The CLI ships an agent skill covering the turn loop, conflict handling and exit
codes:

```sh
excali skills install                  # ./.claude/skills/excalidraw-collab/
excali skills install --scope user     # ~/.claude/skills/excalidraw-collab/
excali skills install --client agents  # .agents/skills/… instead of .claude/
```

## Configuration

| Setting | Env var | Fallback |
|---|---|---|
| Server URL | `EXCALI_SERVER` | `server` in the config file |
| API token | `EXCALI_TOKEN` | `token` in the config file |

Config file: `$XDG_CONFIG_HOME/excali/config.json`, else
`~/.config/excali/config.json` (written `0600` by `excali login`).

Full command reference:
[docs/cli.md](https://github.com/femoral/excalidraw-collab/blob/main/docs/cli.md).

MIT licensed.
