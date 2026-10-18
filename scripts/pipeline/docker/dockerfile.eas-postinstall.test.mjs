import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

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
  }
});

test("Dockerfile deps stages copy the shared yarn-install-with-retry helper from scripts/ci", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");

  for (const marker of [
    "FROM node:${NODE_VERSION}-alpine AS deps-alpine",
    "FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps-alpine-build",
    "FROM node:${NODE_VERSION} AS deps-debian",
  ]) {
    const section = extractStageSection(raw, marker);
    assert.match(section, /COPY scripts\/ci\/yarn-install-with-retry\.sh \/usr\/local\/bin\/yarn-install-with-retry/);
    assert.doesNotMatch(section, /COPY docker\/scripts\/yarn-install-with-retry\.sh \/usr\/local\/bin\/yarn-install-with-retry/);
  }
});

test("Dockerfile installs UI postinstall assets only in web dependency stages", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");

  for (const marker of [
    "FROM node:${NODE_VERSION}-alpine AS deps-alpine",
    "FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps-alpine-build",
  ]) {
    const section = extractStageSection(raw, marker);
    const installIndex = section.indexOf("yarn-install-with-retry --frozen-lockfile");
    const copyIndex = section.indexOf("COPY apps/ui/tools/postinstall ./apps/ui/tools/postinstall");

    assert.ok(installIndex >= 0, `${marker} must install dependencies`);
    assert.ok(copyIndex >= 0, `${marker} must copy the UI postinstall runner`);
    assert.ok(
      copyIndex < installIndex,
      `${marker} must copy the UI postinstall runner before dependency install`,
    );
  }

  const serverDeps = extractStageSection(raw, "FROM node:${NODE_VERSION} AS deps-debian");
  const workspaceManifests = Array.from(
    serverDeps.matchAll(/^\s*COPY ((?:apps|packages)\/[^ ]+\/package\.json) /gm),
    (match) => match[1],
  ).sort();
  assert.deepEqual(workspaceManifests, [
    "apps/server/package.json",
    "packages/agents/package.json",
    "packages/cli-common/package.json",
    "packages/privacy-kit/package.json",
    "packages/protocol/package.json",
    "packages/release-runtime/package.json",
  ]);
  assert.doesNotMatch(serverDeps, /COPY apps\/ui\/tools\/postinstall /);
});

test("Dockerfile builds the source workspaces required by server generation", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");

  for (const marker of [
    "FROM node:${NODE_VERSION}-alpine AS deps-alpine",
    "FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps-alpine-build",
    "FROM node:${NODE_VERSION} AS deps-debian",
  ]) {
    const section = extractStageSection(raw, marker);
    assert.match(section, /COPY packages\/privacy-kit\/package\.json packages\/privacy-kit\//);
  }

  const serverBuilder = extractStageSection(raw, "FROM deps-debian AS server-builder");
  const privacyBuildIndex = serverBuilder.indexOf("yarn workspace privacy-kit build");
  const serverBuildIndex = serverBuilder.indexOf("yarn workspace @happier-dev/server build");
  assert.match(serverBuilder, /COPY packages\/privacy-kit \.\/packages\/privacy-kit/);
  assert.ok(privacyBuildIndex >= 0, "server builder must build privacy-kit from the checkout");
  assert.ok(serverBuildIndex >= 0, "server builder must build the server");
  assert.ok(privacyBuildIndex < serverBuildIndex, "privacy-kit must be built before the server");
  const releaseRuntimeBuildIndex = serverBuilder.indexOf("yarn workspace @happier-dev/release-runtime postinstall:real");
  const cliCommonBuildIndex = serverBuilder.indexOf("yarn workspace @happier-dev/cli-common postinstall:real");
  const serverGenerationIndex = serverBuilder.indexOf("yarn workspace @happier-dev/server postinstall:real");
  assert.ok(cliCommonBuildIndex >= 0, "server client generation requires built cli-common exports");
  assert.ok(releaseRuntimeBuildIndex < cliCommonBuildIndex, "cli-common requires built release-runtime exports");
  assert.ok(cliCommonBuildIndex < serverGenerationIndex, "cli-common must be built before server client generation");

  const server = extractStageSection(raw, "FROM node:${NODE_VERSION} AS server");
  assert.match(
    server,
    /COPY --from=server-builder --chown=node:node \/repo\/packages\/privacy-kit \/repo\/packages\/privacy-kit/,
  );
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
    const stackUtilsCopyIndex = section.indexOf(
      "COPY apps/stack/scripts/utils ./apps/stack/scripts/utils",
    );
    const workspaceLockCopyIndex = section.indexOf(
      "COPY packages/cli-common/workspaceBundleLock.mjs packages/cli-common/workspaceLockLease.mjs packages/cli-common/processInstance.mjs ./packages/cli-common/",
    );

    assert.ok(installIndex >= 0, `${marker} must install dependencies`);
    assert.ok(copyIndex >= 0, `${marker} must copy scripts/workspaces`);
    assert.ok(stackUtilsCopyIndex >= 0, `${marker} must copy the workspace build utility dependency closure`);
    assert.ok(workspaceLockCopyIndex >= 0, `${marker} must copy the workspace lock dependency closure`);
    assert.ok(
      installIndex < copyIndex,
      `${marker} must copy scripts/workspaces after dependency install so helper edits do not invalidate the install cache`,
    );
    assert.ok(
      installIndex < stackUtilsCopyIndex,
      `${marker} must copy the workspace build utility dependency closure after dependency install`,
    );
    assert.ok(
      installIndex < workspaceLockCopyIndex,
      `${marker} must copy the workspace lock dependency closure after dependency install`,
    );
  }
});

test("dev-box Dockerfile no longer runs a source yarn install", () => {
  const dockerfilePath = path.join(repoRoot, "docker", "dev-box", "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");
  assert.doesNotMatch(raw, /yarn-install-with-retry/);
  assert.doesNotMatch(raw, /COPY scripts\/pipeline\/expo\/eas-postinstall\.mjs scripts\/pipeline\/expo\//);
});
