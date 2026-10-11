import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { readBundledPluginPublicationFailures, writeBundledPluginPublicationFailures } from '../../workspaces/bundledPluginPublicationFailure.mjs';

const repoRoot = process.cwd();
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const installActionPath = path.join(repoRoot, '.github', 'actions', 'install-yarn-dependencies', 'action.yml');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-preparation-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const runnerTemp = path.join(root, 'runner');
  fs.mkdirSync(workspace);
  fs.mkdirSync(runnerTemp);
  return { root, workspace, runnerTemp };
}

function write(root, relative, content, mode) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, mode === undefined ? undefined : { mode });
  if (mode !== undefined) fs.chmodSync(destination, mode);
}

function runShellStep(step, workspace, runnerTemp, env = {}) {
  assert.equal(step?.shell ?? 'bash', 'bash');
  assert.equal(typeof step?.run, 'string', 'expected an executable owner shell step');
  return spawnSync('bash', ['-c', step.run], {
    cwd: workspace,
    env: { ...process.env, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp, ...env },
    encoding: 'utf8',
  });
}

test('dependency cache inputs retain installation sources without test-only churn', (t) => {
  const { workspace } = fixture(t);
  const action = yaml.load(fs.readFileSync(installActionPath, 'utf8'));
  const cache = action.runs.steps.find((step) => step.name === 'Restore third-party dependencies');
  const argumentsText = cache.with.key.match(/hashFiles\(([^)]*)\)/u)?.[1];
  assert.equal(typeof argumentsText, 'string', 'cache key must select its actual file inputs');
  const patterns = yaml.load(`[${argumentsText}]`);
  assert.ok(Array.isArray(patterns) && patterns.every((pattern) => typeof pattern === 'string'));
  const installationInputs = [
    'yarn.lock', 'apps/cli/package.json', '.yarnrc',
    'patches/runtime.patch', 'scripts/ci/yarn-install-with-retry.sh',
    '.github/actions/install-yarn-dependencies/action.yml',
    'scripts/workspaces/ensureWorkspacePackagesBuilt.mjs',
    'apps/ui/tools/postinstall.mjs', 'apps/ui/scripts/installFreshnessInputs.mjs',
    'apps/cli/scripts/unpack-tools.cjs',
    'apps/ui/tools/postinstall/verifyNativePatchCompilation.mjs',
    'packages/iroh-native/scripts/build.mjs', 'packages/plugins/example/scripts/build.mjs',
    'apps/stack/scripts/provision/.bun-version',
  ];
  const testInputs = [
    'scripts/workspaces/ensureWorkspacePackagesBuiltCli.test.mjs',
    'apps/ui/tools/postinstall.spec.mjs',
    'apps/ui/tools/postinstall/verifyNativePatchCompilation.test.mjs',
    'packages/iroh-native/scripts/__tests__/build-fixture.mjs',
  ];
  for (const input of [...installationInputs, ...testInputs]) write(workspace, input, 'fixture input');
  // Native filesystem globbing checks these simple inclusion/exclusion patterns;
  // GitHub owns hashFiles hashing and actual hosted cache-hit behavior.
  const selected = new Set(fs.globSync(patterns.filter((pattern) => !pattern.startsWith('!')), {
    cwd: workspace,
    exclude: patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1)),
  }));
  for (const input of installationInputs) assert.ok(selected.has(input), `installation input must invalidate cache: ${input}`);
  for (const input of testInputs) assert.equal(selected.has(input), false, `test-only input must not invalidate cache: ${input}`);
});

test('the current-run preparation archive restores prepared outputs and readiness without collecting source changes', (t) => {
  const { root, workspace, runnerTemp } = fixture(t);
  const workflow = yaml.load(fs.readFileSync(path.join(workflowsDir, 'tests.yml'), 'utf8'));
  const action = yaml.load(fs.readFileSync(installActionPath, 'utf8'));
  const archive = workflow.jobs['gate-prepare']?.steps.find((step) => step.name === "Archive the current run's coherent preparation");
  const restore = action.runs.steps.find((step) => step.name === "Restore this run's prepared workspace");
  write(workspace, 'packages/protocol/package.json', '{"name":"@happier-dev/protocol"}');
  write(workspace, 'packages/protocol/dist/index.js', 'export const current = true;');
  write(workspace, 'apps/bootstrap/package.json', '{"name":"@happier-dev/bootstrap"}');
  write(workspace, 'apps/bootstrap/dist/index.js', 'prepared app-workspace dependency');
  write(workspace, 'packages/plugins/example/package.json', '{"name":"@happier-dev/plugins-example"}');
  write(workspace, 'packages/plugins/example/.happier-plugin/plugin.json', '{"current":true}');
  const untrackedRuntime = 'packages/plugins/example/.happier-plugin/agent/runtime/factory.js';
  write(workspace, untrackedRuntime, 'current published plugin runtime');
  write(workspace, 'packages/plugins/example/.happier-plugin/.env.local', 'private plugin state');
  write(workspace, 'packages/iroh-native/native/iroh.node', 'native-output', 0o755);
  write(workspace, 'apps/cli/tools/unpacked/helper', '#!/bin/sh\nexit 0\n', 0o755);
  write(workspace, 'apps/ui/public/canvaskit.wasm', 'mandatory Skia web postinstall output');
  const ignoredGeneratedOutputs = [
    'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js',
    'packages/protocol/src/features/embeddedFeaturePolicies.generated.ts',
  ];
  for (const output of ignoredGeneratedOutputs) write(workspace, output, `canonical ignored output: ${output}`);
  write(workspace, 'apps/cli/node_modules/@happier-dev/protocol/dist/index.js', 'current physical copy');
  write(workspace, 'node_modules/external/index.js', 'third-party');
  fs.mkdirSync(path.join(workspace, 'node_modules/@happier-dev'), { recursive: true });
  fs.symlinkSync('../../packages/protocol', path.join(workspace, 'node_modules/@happier-dev/protocol'));
  write(workspace, '.project/tmp/cli-source-dev-shared-deps-sync.json', '{"version":8}');
  const failures = [{ packageName: '@happier-dev/plugins-example', pluginId: 'happier.example', diagnostic: { code: 'plugin_package_build_failed', message: 'Unusable plugin build' } }];
  writeBundledPluginPublicationFailures(workspace, failures);
  write(workspace, '.project/private-state', 'not public readiness');
  write(workspace, 'apps/cli/node_modules/external/.project/private-state', 'not dependency state');
  write(workspace, 'node_modules/external/.env', 'secret');
  const generated = 'packages/agents/src/generated/agentIds.ts';
  const untrackedGenerated = 'apps/ui/sources/text/bundledPluginTranslations/ja.generated.ts';
  const serverGenerated = [
    'apps/server/sources/app/api/routes/share/publicShareViewerBundle.generated.ts',
    'apps/server/sources/storage/enums.generated.ts',
    'apps/server/prisma/sqlite/schema.prisma',
    'apps/server/prisma/mysql/schema.prisma',
  ];
  write(workspace, generated, 'export const current = true;');
  write(workspace, untrackedGenerated, 'export const currentLocale = true;');
  for (const output of serverGenerated) write(workspace, output, `current Server projection: ${output}`);
  for (const provider of ['sqlite', 'mysql']) {
    write(workspace, `apps/server/generated/${provider}-client/index.js`, `current ${provider} client`);
    write(workspace, `apps/server/generated/${provider}-client/.happier-source-schema.sha256`, `${provider} schema identity`);
  }
  // No source inventory is required: even an unavailable Git boundary must not
  // prevent archiving the canonical prepared output directories.
  write(workspace, 'apps/cli/src/private.ts', 'not a prepared output');
  write(root, 'bin/git', '#!/bin/sh\necho "unexpected Git inventory invocation" >&2\nexit 42\n', 0o755);
  const result = runShellStep(archive, workspace, runnerTemp, { PATH: `${path.join(root, 'bin')}:${process.env.PATH}` });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const consumer = path.join(root, 'consumer');
  fs.mkdirSync(consumer);
  write(consumer, generated, 'stale checkout projection');
  fs.mkdirSync(path.join(runnerTemp, 'gate-prepared'));
  fs.copyFileSync(path.join(runnerTemp, 'gate-prepared-workspace.tar'), path.join(runnerTemp, 'gate-prepared/gate-prepared-workspace.tar'));
  const restored = runShellStep(restore, consumer, runnerTemp, { RESTORE_STARTED_SECONDS: String(Math.floor(Date.now() / 1000)) });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.readFileSync(path.join(consumer, generated), 'utf8'), 'stale checkout projection');
  for (const output of [untrackedGenerated, ...serverGenerated, 'apps/cli/src/private.ts']) {
    assert.equal(fs.existsSync(path.join(consumer, output)), false);
  }
  for (const provider of ['sqlite', 'mysql']) {
    assert.equal(fs.readFileSync(path.join(consumer, `apps/server/generated/${provider}-client/index.js`), 'utf8'), `current ${provider} client`);
    assert.equal(fs.readFileSync(path.join(consumer, `apps/server/generated/${provider}-client/.happier-source-schema.sha256`), 'utf8'), `${provider} schema identity`);
  }
  assert.equal(fs.readFileSync(path.join(consumer, 'apps/bootstrap/dist/index.js'), 'utf8'), 'prepared app-workspace dependency');
  assert.equal(fs.readFileSync(path.join(consumer, 'apps/ui/public/canvaskit.wasm'), 'utf8'), 'mandatory Skia web postinstall output');
  for (const output of ignoredGeneratedOutputs) {
    assert.equal(fs.readFileSync(path.join(consumer, output), 'utf8'), `canonical ignored output: ${output}`);
  }
  assert.equal(fs.readlinkSync(path.join(consumer, 'node_modules/@happier-dev/protocol')), '../../packages/protocol');
  assert.equal(fs.readFileSync(path.join(consumer, 'apps/cli/node_modules/@happier-dev/protocol/dist/index.js'), 'utf8'), 'current physical copy');
  assert.equal(fs.readFileSync(path.join(consumer, 'packages/plugins/example/.happier-plugin/plugin.json'), 'utf8'), '{"current":true}');
  assert.equal(fs.readFileSync(path.join(consumer, untrackedRuntime), 'utf8'), 'current published plugin runtime');
  for (const file of ['packages/iroh-native/native/iroh.node', 'apps/cli/tools/unpacked/helper']) {
    assert.equal(fs.statSync(path.join(consumer, file)).mode & 0o777, 0o755);
  }
  assert.equal(fs.readFileSync(path.join(consumer, '.project/tmp/cli-source-dev-shared-deps-sync.json'), 'utf8'), '{"version":8}');
  assert.deepEqual(readBundledPluginPublicationFailures(consumer), failures);
  for (const file of ['.project/private-state', 'apps/cli/node_modules/external/.project/private-state', 'node_modules/external/.env', 'packages/plugins/example/.happier-plugin/.env.local']) {
    assert.equal(fs.existsSync(path.join(consumer, file)), false);
  }
});

test('dependency cache excludes stale first-party copies and private state but preserves external executable dependencies', (t) => {
  const { root, workspace, runnerTemp } = fixture(t);
  const action = yaml.load(fs.readFileSync(installActionPath, 'utf8'));
  const archive = action.runs.steps.find((step) => step.name === 'Archive third-party dependencies after successful install');
  write(workspace, 'node_modules/external/bin', '#!/bin/sh\nexit 0\n', 0o755);
  write(workspace, 'apps/cli/node_modules/@happier-dev/protocol/dist/index.js', 'stale copy');
  write(workspace, 'apps/cli/node_modules/privacy-kit/dist/index.js', 'stale unscoped workspace copy');
  write(workspace, 'packages/example/node_modules/external/index.js', 'nested dependency');
  write(workspace, 'node_modules/external/.env.local', 'private');
  write(workspace, 'node_modules/external/.project/private-state', 'private');
  write(workspace, 'node_modules/external/.happier/credentials', 'private');
  write(workspace, 'node_modules/.yarn-integrity', 'previous complete install state');
  write(workspace, 'apps/cli/node_modules/.cache/tsc/build.tsbuildinfo', 'previous source build state');
  const result = runShellStep(archive, workspace, runnerTemp);
  assert.equal(result.status, 0, result.stderr);
  const consumer = path.join(root, 'consumer');
  fs.mkdirSync(consumer);
  const restore = action.runs.steps.find((step) => step.name === 'Extract third-party dependency cache');
  const restored = runShellStep(restore, consumer, runnerTemp);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.statSync(path.join(consumer, 'node_modules/external/bin')).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(consumer, 'packages/example/node_modules/external/index.js'), 'utf8'), 'nested dependency');
  for (const file of ['apps/cli/node_modules/@happier-dev', 'apps/cli/node_modules/privacy-kit', 'node_modules/external/.env.local', 'node_modules/external/.project', 'node_modules/external/.happier', 'node_modules/.yarn-integrity', 'apps/cli/node_modules/.cache']) {
    assert.equal(fs.existsSync(path.join(consumer, file)), false);
  }
});

test('prepared restore refuses a missing artifact and preparation requires canonical readiness', (t) => {
  const { root, workspace, runnerTemp } = fixture(t);
  const workflow = yaml.load(fs.readFileSync(path.join(workflowsDir, 'tests.yml'), 'utf8'));
  const action = yaml.load(fs.readFileSync(installActionPath, 'utf8'));
  const restore = action.runs.steps.find((step) => step.name === "Restore this run's prepared workspace");
  const missing = runShellStep(restore, workspace, runnerTemp, { RESTORE_STARTED_SECONDS: '0' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /gate-prepared-workspace\.tar/);
  fs.mkdirSync(path.join(workspace, 'node_modules'));
  fs.mkdirSync(path.join(workspace, 'apps'));
  fs.mkdirSync(path.join(workspace, 'packages'));
  const archive = workflow.jobs['gate-prepare']?.steps.find((step) => step.name === "Archive the current run's coherent preparation");
  const absentReadiness = runShellStep(archive, workspace, runnerTemp);
  assert.notEqual(absentReadiness.status, 0);
  assert.equal(fs.existsSync(path.join(runnerTemp, 'gate-prepared-workspace.tar')), false);
});

test('GitHub workflows route dependency installs through the shared install-yarn-dependencies action', () => {
  const actionRaw = fs.readFileSync(installActionPath, 'utf8');
  assert.match(
    actionRaw,
    /scripts\/ci\/yarn-install-with-retry\.sh/,
    'expected install-yarn-dependencies action to invoke the shared retrying installer script',
  );
  assert.match(
    actionRaw,
    /ONNXRUNTIME_NODE_INSTALL_CUDA:\s*skip/,
    'expected install-yarn-dependencies action to skip optional ONNX Runtime CUDA downloads in CI',
  );

  const workflowFiles = fs
    .readdirSync(workflowsDir)
    .filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
    .sort();

  let sharedActionUseCount = 0;
  for (const file of workflowFiles) {
    const raw = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
    if (raw.includes('./.github/actions/install-yarn-dependencies')) {
      sharedActionUseCount += 1;
    }
    assert.doesNotMatch(
      raw,
      /\byarn install\b/,
      `${file} should use the shared install-yarn-dependencies action instead of raw yarn install`,
    );
    assert.doesNotMatch(
      raw,
      /- name: Install dependencies(?:(?!\n\s*- name:)[\s\S])*?shell:\s*[^\n]+(?:(?!\n\s*- name:)[\s\S])*?uses:\s*\.\/\.github\/actions\/install-yarn-dependencies/,
      `${file} should not keep shell on an install-yarn-dependencies action step`,
    );
  }

  assert.ok(sharedActionUseCount > 0, 'expected at least one workflow to use the shared install-yarn-dependencies action');
});
