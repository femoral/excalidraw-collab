# Upgrade runbook — `@excalidraw/excalidraw`

This project **never forks** upstream Excalidraw. Upgrades are a version bump of
the published npm package, then a fixed verification pass against the four
contact points in [PLAN.md](../PLAN.md) §2 and the `packages/core` fixture
corpus.

Current pin (keep these in lockstep):

| Package | Where declared |
|---|---|
| `@excalidraw/excalidraw` | `packages/web/package.json` (runtime) |
| `@excalidraw/excalidraw` | `packages/core/package.json` (`devDependency` for fixture generation) |

## 1. Bump

```sh
# From monorepo root — set NEW to the target version (e.g. 0.19.0)
NEW=0.19.0

# Edit both package.json files to the same version, then:
pnpm install
pnpm build
```

Prefer an exact version (no `^`) so the pin stays deliberate.

## 2. Run the fixture suite

```sh
pnpm --filter @excalidraw-collab/core test
pnpm test   # full monorepo once core is green
```

`packages/core` keeps real `.excalidraw` files under
`packages/core/test/fixtures/` (scenes + `pairs/` before/after). Diff, normalize,
hash, and digest tests load them. If these fail after a bump, the schema or
element shape moved — do not paper over with production code that rewrites
element internals.

## 3. Check the four contact points (PLAN.md §2)

| Contact point | What we use | Where to look | What to verify |
|---|---|---|---|
| **`<Excalidraw />` component** | `initialData`, `onChange`, `excalidrawAPI`, `<MainMenu>` children | `packages/web/src/SceneEditor.tsx` | Props still typecheck; editor loads a scene, autosaves draft, commit-turn still works |
| **Exported utils** | `restoreElements`, `reconcileElements`, `getSceneVersion`, `serializeAsJSON`, `exportToSvg` / `exportToBlob`, `convertToExcalidrawElements`, `CaptureUpdateAction` | `packages/web/src/RenderPage.tsx`, `packages/web/src/SceneEditor.tsx`, `packages/core/scripts/generate-fixtures.mjs` | Imports resolve; render worker export/merge/skeleton still pass tests |
| **`.excalidraw` JSON schema** | Stored verbatim; we never rewrite element internals | Fixtures + `normalizeScene` / `diffScenes` in `packages/core` | Round-trip fixtures; old scenes still load in the editor (`restore()` repairs) |
| **Fonts / assets** | `window.EXCALIDRAW_ASSET_PATH = "/"` + fonts copied from the package `dist/prod/fonts` at build time | `packages/web/src/main.tsx`, `packages/web/vite.config.ts` | Fonts still copy into the web build; offline editor renders text |

Non-negotiable (PLAN.md §2): **the server never authors or mutates element
internals by hand.** Merge and skeleton conversion always go through upstream
utils in the render worker.

Suggested package-level checks after the contact-point review:

```sh
pnpm --filter @excalidraw-collab/web test
pnpm --filter @excalidraw-collab/render test
pnpm --filter @excalidraw-collab/server test
pnpm --filter @excalidraw-collab/cli test
```

If `RENDER_WORKER=on` is available in your environment, also smoke:

```sh
# Against a local server with the new web build served
excalicli export SLUG --format png -o ./smoke.png
excalicli push SLUG --skeleton -m "upgrade smoke" -f smoke.skeleton.json
# optional: push with --merge after a deliberate conflict
```

## 4. Re-record fixtures if the schema moved

Only when tests fail because fixtures no longer match what the new package
emits (or `serializeAsJSON` / `convertToExcalidrawElements` output changed).

```sh
cd packages/core
pnpm run generate-fixtures
# Review the git diff under test/fixtures/ carefully
pnpm test
cd ../..
```

Notes:

- Generation uses the real `@excalidraw/excalidraw` package via
  `packages/core/scripts/generate-fixtures.mjs` (seeded RNG for stability).
- Commit fixture updates in the **same change** as the version bump so CI never
  sees a mismatched pin.
- If only a small subset of fixtures break, still re-run the full generator —
  partial hand-edits of fixture JSON are discouraged.

## 5. Finish

```sh
pnpm install
pnpm build
pnpm test
```

Commit message example:

```
chore: bump @excalidraw/excalidraw to X.Y.Z

Re-recorded core fixtures; verified PLAN.md §2 contact points.
```

## Failure playbook

| Symptom | Action |
|---|---|
| Core fixture / diff tests fail | Re-record fixtures (§4); inspect element prop renames |
| Web build fails on Excalidraw imports | Adjust contact-point imports only; do not vendor a fork |
| Render export/merge/skeleton 501 or throws | Check `exportToBlob` / `reconcileElements` / `convertToExcalidrawElements` API drift in `RenderPage.tsx` |
| Fonts missing / boxes for text | Re-check asset path and vite font copy from `dist/prod/fonts` |
| Server tests fail on merge | Merge must still call upstream `restoreElements` + `reconcileElements` only |

If an upgrade requires rewriting element fields on the server, **stop** — that
violates the project rule. Fix at a contact point (usually web/render) or wait
for upstream.

## Related docs

- Design authority: [PLAN.md](../PLAN.md) §2, §6, §9
- Agent workflow: [AGENTS.md](../AGENTS.md)
- CLI surface: [cli.md](./cli.md)
