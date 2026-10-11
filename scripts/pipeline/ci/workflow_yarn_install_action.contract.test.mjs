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

test('the current-run preparation archive restores native modes, workspace links, generated inputs and readiness together', (t) => {
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
  write(workspace, 'packages/iroh-native/native/iroh.node', 'native-output', 0o755);
  write(workspace, 'apps/cli/tools/unpacked/helper', '#!/bin/sh\nexit 0\n', 0o755);
  write(workspace, 'apps/ui/public/canvaskit.wasm', 'mandatory Skia web postinstall output');
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
  write(workspace, generated, 'export const current = true;');
  write(workspace, untrackedGenerated, 'export const currentLocale = true;');
  // Git is an external process boundary: the fresh checkout's producer diff is
  // supplied here; the actual archive selection, filesystem and tar stay real.
  write(root, 'bin/git', '#!/bin/sh\ncase "$1" in\n  diff) printf "packages/agents/src/generated/agentIds.ts\\0" ;;\n  ls-files) printf "apps/ui/sources/text/bundledPluginTranslations/ja.generated.ts\\0" ;;\nesac\n', 0o755);
  const result = runShellStep(archive, workspace, runnerTemp, { PATH: `${path.join(root, 'bin')}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  const consumer = path.join(root, 'consumer');
  fs.mkdirSync(consumer);
  write(consumer, generated, 'stale checkout projection');
  fs.mkdirSync(path.join(runnerTemp, 'gate-prepared'));
  fs.copyFileSync(path.join(runnerTemp, 'gate-prepared-workspace.tar'), path.join(runnerTemp, 'gate-prepared/gate-prepared-workspace.tar'));
  const restored = runShellStep(restore, consumer, runnerTemp, { RESTORE_STARTED_SECONDS: String(Math.floor(Date.now() / 1000)) });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.readFileSync(path.join(consumer, generated), 'utf8'), 'export const current = true;');
  assert.equal(fs.readFileSync(path.join(consumer, untrackedGenerated), 'utf8'), 'export const currentLocale = true;');
  assert.equal(fs.readFileSync(path.join(consumer, 'apps/bootstrap/dist/index.js'), 'utf8'), 'prepared app-workspace dependency');
  assert.equal(fs.readFileSync(path.join(consumer, 'apps/ui/public/canvaskit.wasm'), 'utf8'), 'mandatory Skia web postinstall output');
  assert.equal(fs.readlinkSync(path.join(consumer, 'node_modules/@happier-dev/protocol')), '../../packages/protocol');
  assert.equal(fs.readFileSync(path.join(consumer, 'apps/cli/node_modules/@happier-dev/protocol/dist/index.js'), 'utf8'), 'current physical copy');
  assert.equal(fs.readFileSync(path.join(consumer, 'packages/plugins/example/.happier-plugin/plugin.json'), 'utf8'), '{"current":true}');
  for (const file of ['packages/iroh-native/native/iroh.node', 'apps/cli/tools/unpacked/helper']) {
    assert.equal(fs.statSync(path.join(consumer, file)).mode & 0o777, 0o755);
  }
  assert.equal(fs.readFileSync(path.join(consumer, '.project/tmp/cli-source-dev-shared-deps-sync.json'), 'utf8'), '{"version":8}');
  assert.deepEqual(readBundledPluginPublicationFailures(consumer), failures);
  for (const file of ['.project/private-state', 'apps/cli/node_modules/external/.project/private-state', 'node_modules/external/.env']) {
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

test('prepared restore refuses a missing artifact and preparation refuses an unrecognized source mutation', (t) => {
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
  write(root, 'bin/git', '#!/bin/sh\nprintf "apps/cli/src/private.ts\\0"\n', 0o755);
  const archive = workflow.jobs['gate-prepare']?.steps.find((step) => step.name === "Archive the current run's coherent preparation");
  const unexpected = runShellStep(archive, workspace, runnerTemp, { PATH: `${path.join(root, 'bin')}:${process.env.PATH}` });
  assert.notEqual(unexpected.status, 0);
  assert.match(unexpected.stdout, /Unexpected preparation source change: apps\/cli\/src\/private\.ts/);
  assert.equal(fs.existsSync(path.join(runnerTemp, 'gate-prepared-workspace.tar')), false);
  write(root, 'bin/git', '#!/bin/sh\nprintf "packages/agents/src/generated/agentIds.ts\\0"\n', 0o755);
  const deleted = runShellStep(archive, workspace, runnerTemp, { PATH: `${path.join(root, 'bin')}:${process.env.PATH}` });
  assert.notEqual(deleted.status, 0);
  assert.match(deleted.stdout, /Preparation deleted generated source: packages\/agents\/src\/generated\/agentIds\.ts/);
  write(root, 'bin/git', '#!/bin/sh\nexit 42\n', 0o755);
  const failedInventory = runShellStep(archive, workspace, runnerTemp, { PATH: `${path.join(root, 'bin')}:${process.env.PATH}` });
  assert.equal(failedInventory.status, 42);
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
