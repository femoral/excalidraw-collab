/**
 * Packaging tripwire for the publishable CLI (and its publishable runtime
 * deps). Catches the class of mistake where the CLI depends at runtime on a
 * `private: true` workspace package that cannot be installed from the registry.
 *
 * Rules:
 *  - `@excalidraw-collab/cli` is publishable (not private).
 *  - Every runtime `dependency` is a non-private workspace package (no
 *    third-party packages — CLI budget is zero external runtime deps).
 *  - Each of those deps is itself free of private / third-party runtime deps
 *    (transitively), so a published tarball is installable.
 *  - `@excalidraw-collab/server` may remain a private devDependency.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.resolve(cliDir, "..");

type PackageJson = {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
  exports?: unknown;
  main?: string;
  types?: string;
};

function readPackageJson(dir: string): PackageJson {
  const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
  return JSON.parse(raw) as PackageJson;
}

/** Map package name → package directory under packages/. */
function workspacePackages(): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    const pkgPath = path.join(dir, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = readPackageJson(dir);
    if (typeof pkg.name === "string") {
      map.set(pkg.name, dir);
    }
  }
  return map;
}

function isWorkspaceProtocol(spec: string): boolean {
  return spec === "workspace:*" || spec.startsWith("workspace:");
}

test("CLI is publishable (not private)", () => {
  const cli = readPackageJson(cliDir);
  assert.equal(cli.name, "@excalidraw-collab/cli");
  assert.notEqual(
    cli.private,
    true,
    "CLI must be publishable; remove private: true",
  );
  assert.ok(
    Array.isArray(cli.files) && cli.files.includes("dist"),
    'CLI package.json "files" must include "dist"',
  );
});

test("CLI runtime deps are non-private workspace packages (no third-party)", () => {
  const workspace = workspacePackages();
  const cli = readPackageJson(cliDir);
  const deps = cli.dependencies ?? {};
  const names = Object.keys(deps);

  // Zero third-party runtime deps is the budget; workspace siblings only.
  for (const [name, spec] of Object.entries(deps)) {
    assert.ok(
      isWorkspaceProtocol(spec),
      `CLI runtime dependency ${name}@${spec} must use workspace: protocol ` +
        `(no third-party registry packages)`,
    );
    assert.ok(
      workspace.has(name),
      `CLI runtime dependency ${name} is not a monorepo workspace package`,
    );
    const depDir = workspace.get(name)!;
    const depPkg = readPackageJson(depDir);
    assert.notEqual(
      depPkg.private,
      true,
      `CLI runtime dependency ${name} is private:true — publishing the CLI ` +
        `would produce an un-installable package. Make ${name} publishable ` +
        `(remove private) or stop depending on it at runtime.`,
    );
  }

  // Document the current expected surface so accidental additions fail loudly.
  assert.deepEqual(
    names.slice().sort(),
    ["@excalidraw-collab/core"],
    "CLI runtime dependencies drifted from the expected set " +
      "(@excalidraw-collab/core only)",
  );
});

test("CLI server package stays a devDependency (may be private)", () => {
  const cli = readPackageJson(cliDir);
  const dev = cli.devDependencies ?? {};
  assert.ok(
    "@excalidraw-collab/server" in dev,
    "server must remain a CLI devDependency for e2e tests",
  );
  assert.ok(
    !("@excalidraw-collab/server" in (cli.dependencies ?? {})),
    "server must not be a runtime dependency of the CLI",
  );
});

test("publishable runtime deps ship dist and have no private/third-party runtime deps", () => {
  const workspace = workspacePackages();
  const cli = readPackageJson(cliDir);
  const visited = new Set<string>();
  const queue = Object.keys(cli.dependencies ?? {});

  while (queue.length > 0) {
    const name = queue.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);

    const dir = workspace.get(name);
    assert.ok(dir, `missing workspace package for ${name}`);
    const pkg = readPackageJson(dir);

    assert.notEqual(
      pkg.private,
      true,
      `publishable dependency chain includes private package ${name}`,
    );
    assert.ok(
      Array.isArray(pkg.files) && pkg.files.includes("dist"),
      `${name} package.json "files" must include "dist" so the published tarball has build output`,
    );
    assert.ok(
      pkg.exports !== undefined || pkg.main !== undefined,
      `${name} must declare exports or main for consumers`,
    );

    for (const [depName, spec] of Object.entries(pkg.dependencies ?? {})) {
      assert.ok(
        isWorkspaceProtocol(spec),
        `${name} runtime dependency ${depName}@${spec} must be a workspace package ` +
          `(publishable packages in this monorepo carry no third-party runtime deps ` +
          `when they sit under the CLI)`,
      );
      assert.ok(
        workspace.has(depName),
        `${name} runtime dependency ${depName} is not in the workspace`,
      );
      const nested = readPackageJson(workspace.get(depName)!);
      assert.notEqual(
        nested.private,
        true,
        `${name} depends at runtime on private package ${depName}`,
      );
      queue.push(depName);
    }
  }

  assert.ok(
    visited.has("@excalidraw-collab/core"),
    "expected @excalidraw-collab/core in the publishable runtime graph",
  );
});
