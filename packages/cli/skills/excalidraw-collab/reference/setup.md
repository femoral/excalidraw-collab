# Setup and prerequisites

**Read this only when `excali whoami` fails, `excali` is not on PATH, or
the user explicitly asks you to help wire things up.** Everything here is the
user's responsibility — surface the right command, don't guess at a server URL
or mint credentials unprompted.

## Is the CLI available?

```sh
excali --help
```

If the binary is missing, it is published on npm and needs Node 24+. Installing
it is the user's call — suggest one of these rather than running it unprompted:

```sh
npm install -g @excalidraw-collab/cli    # or: pnpm add -g @excalidraw-collab/cli
npx @excalidraw-collab/cli --help        # one-off, no install
```

Inside a checkout of the excalidraw-collab monorepo, `pnpm install && pnpm build`
then `node packages/cli/bin/excali` works too.

The binary name is always `excali`, however it is invoked.

## Is there a server?

A running excalidraw-collab server is required. The project ships a Docker
Compose file and a Kubernetes manifest set; the repo README has the quickstart.
If no server is reachable, say so and stop — bringing one up is a user decision.

## Credentials

The CLI needs a base URL and a bearer token:

```sh
excali login --server http://HOST:PORT --token YOUR_TOKEN
excali whoami
```

`YOUR_TOKEN` is either the server's `BOOTSTRAP_TOKEN` (admin, valid from first
boot) or a named token minted by an admin:

```sh
excali token create agent-name    # secret is printed exactly once
excali token ls
excali token revoke agent-name
```

`login` writes `~/.config/excali/config.json` with mode `0600` (or
`$XDG_CONFIG_HOME/excali/config.json`).

Environment variables override the config file:

| Env var         | Purpose      |
| --------------- | ------------ |
| `EXCALI_SERVER` | Base URL     |
| `EXCALI_TOKEN`  | Bearer token |

Never write a token into a repository, issue, commit message, or any file that
leaves the machine.

## Working directory

Pick one project directory and run every command from it. The CLI stores
`.excalidraw-collab/state.json` there — the last version pulled or pushed per
scene, per server. That file is what makes `diff --since-last-pull` and safe
`push` work. Never hand-edit it or invent version numbers; pull and push
maintain it.

Default scene file paths, also relative to that directory:

| Mode                         | Default path         |
| ---------------------------- | -------------------- |
| Full document                | `SLUG.excalidraw`    |
| Skeleton (`push --skeleton`) | `SLUG.skeleton.json` |

## Optional server capabilities

Some commands need the server's render worker (`RENDER_WORKER=on`, Playwright
installed):

| Feature                                     | Needs render worker |
| ------------------------------------------- | ------------------- |
| `describe`, `diff`, `pull`, `push`, `watch` | No                  |
| `export --format png` / `--format svg`      | Yes                 |
| `push --skeleton`                           | Yes                 |
| `push --merge`                              | Yes                 |

If one of these fails with a "not available" message, fall back to the
text path (`describe`, full-document push, manual rebase). Do not build a
client-side substitute.

## Admin commands

```sh
excali backup -o backup.tar.gz
excali restore backup.tar.gz      # see --on-collision
```

Both require an admin token. `restore` overwrites server state — confirm with
the user first.
