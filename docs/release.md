# Releasing the CLI to npm

Two packages are published, both public under the `@excalidraw-collab` scope:

| Package                   | Why it ships                      |
| ------------------------- | --------------------------------- |
| `@excalidraw-collab/cli`  | the `excali` binary               |
| `@excalidraw-collab/core` | the CLI's only runtime dependency |

`@excalidraw-collab/server`, `render` and `web` stay unpublished. The
`publishable-deps` test in the CLI package enforces that split — if it fails,
something private leaked into the CLI's runtime dependency graph.

## One-time setup

```sh
npm login                       # account must own (or be able to create) the scope
npm org ls <your-org> 2>/dev/null   # optional: publishing under an org
```

The first `pnpm publish` creates the scope. Both packages carry
`publishConfig.access: public`, so scoped packages are not published privately
by accident.

## Cutting a release

Versions are kept in lockstep. From the repo root:

```sh
pnpm install
pnpm build
pnpm test                       # must be green

V=0.1.0                         # the version you are cutting
pnpm --filter @excalidraw-collab/core version $V --no-git-tag-version
pnpm --filter @excalidraw-collab/cli  version $V --no-git-tag-version

git commit -am "release: v$V"
git tag "v$V"
```

Inspect the tarballs before pushing anything to the registry:

```sh
pnpm --filter @excalidraw-collab/cli pack --pack-destination /tmp/pack
tar -tzf /tmp/pack/excalidraw-collab-cli-$V.tgz
```

`workspace:*` is rewritten to the real version only by pnpm — always publish and
pack with `pnpm`, never with bare `npm publish`.

Publish core first (the CLI depends on it):

```sh
pnpm --filter @excalidraw-collab/core publish --access public
pnpm --filter @excalidraw-collab/cli  publish --access public
git push && git push --tags
```

Add `--dry-run` to either command to rehearse.

## Verify

```sh
npm install -g @excalidraw-collab/cli
excali --help
excali skills ls
```

## Notes

- Node 24+ is required (`engines.node`); npm warns on older runtimes.
- Published files are `bin/`, `dist/` (minus tests and source maps) and
  `skills/`. Adding a bundled asset means adding it to `files` too.
- The binary is `excali`. Config lives in `~/.config/excali/config.json`; the
  pre-rename `~/.config/excalicli/` path and `EXCALICLI_*` env vars are still
  read as a fallback.
