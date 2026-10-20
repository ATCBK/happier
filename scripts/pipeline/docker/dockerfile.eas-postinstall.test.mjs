import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { collectWorkspacePackageJsonPaths } from "../../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

function extractStageSection(dockerfile, stageMarker) {
  const start = dockerfile.indexOf(stageMarker);
  assert.ok(start >= 0, `missing stage marker: ${stageMarker}`);
  const after = dockerfile.slice(start);
  const nextFromIndex = after.indexOf("\nFROM ");
  return nextFromIndex >= 0 ? after.slice(0, nextFromIndex) : after;
}

test("Dockerfile deps stages include the root postinstall script (eas-postinstall.mjs) so yarn install can run in minimal build contexts", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");

  for (const marker of [
    "FROM node:${NODE_VERSION}-alpine AS deps-alpine",
    "FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps-alpine-build",
    "FROM node:${NODE_VERSION} AS deps-debian",
  ]) {
    const section = extractStageSection(raw, marker);
    assert.match(section, /COPY scripts\/pipeline\/expo\/eas-postinstall\.mjs scripts\/pipeline\/expo\//);
    assert.match(section, /COPY scripts\/ci\/yarn-install-with-retry\.sh \/usr\/local\/bin\/yarn-install-with-retry/);
    if (marker.endsWith('AS deps-debian')) {
      const dockerIgnore = fs.readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8');
      assert.match(dockerIgnore, /^!patches\/?$/m, 'root dependency patches must enter the Docker build context');
      assert.match(dockerIgnore, /^!patches\/\*\*$/m, 'root dependency patch contents must enter the Docker build context');
      const patchCopyIndex = section.search(/^\s*COPY\s+patches\/?\s+\.\/patches\/?\s*$/m);
      const installIndex = section.indexOf('yarn-install-with-retry --frozen-lockfile');
      assert.ok(patchCopyIndex >= 0 && patchCopyIndex < installIndex,
        'server dependencies must consume root dependency patches during the existing install');
    }
  }
});

test("Dockerfile deps stages copy shared workspace build tooling for derived workspace postinstall builds", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");

  for (const marker of [
    "FROM node:${NODE_VERSION}-alpine AS deps-alpine",
    "FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps-alpine-build",
    "FROM node:${NODE_VERSION} AS deps-debian",
  ]) {
    const section = extractStageSection(raw, marker);
    const installIndex = section.indexOf("yarn-install-with-retry --frozen-lockfile");
    const copyIndex = section.indexOf("COPY scripts/workspaces ./scripts/workspaces");

    assert.ok(installIndex >= 0, `${marker} must install dependencies`);
    assert.ok(copyIndex >= 0, `${marker} must copy scripts/workspaces`);
    assert.ok(
      installIndex < copyIndex,
      `${marker} must copy scripts/workspaces after dependency install so helper edits do not invalidate the install cache`,
    );
  }
});

test("dev-box Dockerfile no longer runs a source yarn install", () => {
  const dockerfilePath = path.join(repoRoot, "docker", "dev-box", "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");

  assert.doesNotMatch(raw, /AS cli-builder/);
  assert.doesNotMatch(raw, /yarn-install-with-retry --frozen-lockfile/);
  assert.doesNotMatch(raw, /COPY scripts\/pipeline\/expo\/eas-postinstall\.mjs scripts\/pipeline\/expo\//);
});


test("server images share the production dependency closure and retain their declared runtime workspaces", async () => {
  const raw = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const deps = extractStageSection(raw, "FROM node:${NODE_VERSION} AS deps-debian");
  assert.match(deps, /COPY --parents apps\/\*\/package\.json packages\/\*\/package\.json packages\/plugins\/\*\/package\.json \.\//);
  assert.match(deps, /COPY apps\/ui\/tools\/postinstall \.\/apps\/ui\/tools\/postinstall/);

  const builder = extractStageSection(raw, "FROM deps-debian AS server-builder");
  assert.match(builder, /COPY packages \.\/packages/);
  const prepareIndex = builder.indexOf("yarn workspace @happier-dev/server build:shared");
  const generateIndex = builder.indexOf("yarn workspace @happier-dev/server postinstall:real");
  assert.ok(prepareIndex >= 0 && prepareIndex < generateIndex,
    "the canonical workspace builder must prepare shared exports before server generation");

  const runtime = extractStageSection(raw, "FROM server-builder AS server-runtime");
  assert.match(runtime, /RUN node <<'NODE'/);
  assert.match(runtime, /fs\.rmSync/);
  extractStageSection(raw, "FROM server-runtime AS server-stress");
  const server = extractStageSection(raw, "FROM node:${NODE_VERSION} AS server");
  assert.match(server, /COPY --from=server-runtime --chown=node:node \/repo\/node_modules \/repo\/node_modules/);

  const workspaces = new Map();
  for (const file of await collectWorkspacePackageJsonPaths(repoRoot)) {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    workspaces.set(pkg.name, { dir: path.relative(repoRoot, path.dirname(file)).split(path.sep).join("/"), pkg });
  }
  const visited = new Set();
  const checkRuntimeWorkspace = (name) => {
    if (visited.has(name) || !workspaces.has(name)) return;
    visited.add(name);
    const { dir, pkg } = workspaces.get(name);
    assert.ok(server.includes(`/repo/${dir} /repo/${dir}`), `server image must retain runtime workspace ${name}`);
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      checkRuntimeWorkspace(dep);
    }
  };
  checkRuntimeWorkspace("@happier-dev/server");

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "happier-docker-runtime-"));
  const writePackage = (dir, pkg) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  };
  try {
    for (const name of visited) {
      const { dir, pkg } = workspaces.get(name);
      writePackage(path.join(fixtureRoot, dir), pkg);
      if (name !== "@happier-dev/server") {
        writePackage(path.join(fixtureRoot, "node_modules", ...name.split("/")), pkg);
      }
    }
    writePackage(path.join(fixtureRoot, "apps/server/node_modules/sharp"), {
      name: "sharp", version: "0.35.5", optionalDependencies: { "@img/sharp-linux-x64": "0.35.5" },
    });
    writePackage(path.join(fixtureRoot, "apps/server/node_modules/@img/sharp-linux-x64"), {
      name: "@img/sharp-linux-x64", version: "0.35.5",
    });
    const nativeAddon = path.join(fixtureRoot, "apps/server/node_modules/@img/sharp-linux-x64/runtime.node");
    const generatedEngine = path.join(fixtureRoot, "node_modules/.prisma/client/query-engine.node");
    for (const file of [nativeAddon, generatedEngine]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "runtime-output");
    }
    writePackage(path.join(fixtureRoot, "node_modules/redis-memory-server"), {
      name: "redis-memory-server", version: "0.16.0", dependencies: { "extract-zip": "^2.0.1" },
    });
    writePackage(path.join(fixtureRoot, "node_modules/extract-zip"), { name: "extract-zip", version: "2.0.1" });
    writePackage(path.join(fixtureRoot, "node_modules/@happier-dev/cli"), {
      name: "@happier-dev/cli", dependencies: { "@huggingface/transformers": "^3.8.1" },
    });
    writePackage(path.join(fixtureRoot, "node_modules/@huggingface/transformers"), {
      name: "@huggingface/transformers", dependencies: { sharp: "^0.34.1" },
    });
    writePackage(path.join(fixtureRoot, "node_modules/@huggingface/transformers/node_modules/sharp"), {
      name: "sharp", version: "0.34.5",
    });
    const projection = runtime.match(/RUN node <<'NODE'\n([\s\S]*?)\nNODE/);
    assert.ok(projection, "the shared runtime stage must invoke its dependency projection");
    const result = spawnSync(process.execPath, ["-e", projection[1]], { cwd: fixtureRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(fixtureRoot, "node_modules/@huggingface/transformers")), false);
    assert.equal(fs.existsSync(path.join(fixtureRoot, "node_modules/@happier-dev/cli")), false);
    assert.equal(fs.existsSync(path.join(fixtureRoot, "apps/server/node_modules/sharp/package.json")), true);
    for (const file of [nativeAddon, generatedEngine]) assert.equal(fs.readFileSync(file, "utf8"), "runtime-output");
    assert.equal(fs.existsSync(path.join(fixtureRoot, "node_modules/redis-memory-server/package.json")), false);
    assert.equal(fs.existsSync(path.join(fixtureRoot, "node_modules/extract-zip/package.json")), false);
    for (const name of visited) {
      if (name !== "@happier-dev/server") {
        assert.equal(fs.existsSync(path.join(fixtureRoot, "node_modules", ...name.split("/"), "package.json")), true,
          `projection must retain declared runtime workspace ${name}`);
      }
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
