import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, onTestFailed, onTestFinished } from 'vitest';

import { projectPath } from '@/projectPath';
import { withTempDir } from '@/testkit/fs/tempDir';
import { spawnTestProcess } from '@/testkit/process/spawn';
import { resolveCliTsxTsconfigPath } from '@/utils/spawnHappyCLI';

async function writeModuleLoadObserver(observerPath: string, observationsPath: string): Promise<void> {
  await writeFile(observationsPath, '', 'utf8');
  // Observe the real Node loader without redirecting or substituting modules.
  await writeFile(observerPath, [
    'import { appendFileSync } from "node:fs";',
    'let output;',
    'export function initialize(data) { output = data.output; }',
    'export async function load(url, context, nextLoad) {',
    '  const result = await nextLoad(url, context);',
    '  appendFileSync(output, JSON.stringify(url) + "\\n");',
    '  return result;',
    '}',
  ].join('\n'), 'utf8');
}

describe('first-party Agent runtime demand', () => {
  it.each([
    { agentId: 'claude', implementation: 'nativeRuntime.ts' },
    { agentId: 'codex', implementation: 'engine.ts' },
  ])('keeps $agentId executable code unloaded until its registered factory runs', async ({ agentId, implementation }) => {
    const cliRoot = projectPath();
    const repoRoot = join(cliRoot, '..', '..');
    const pluginRoot = join(repoRoot, 'packages', 'plugins', agentId);
    const sourceRuntimeUrl = pathToFileURL(join(repoRoot, 'packages', 'cli-common', 'registerSourceRuntime.mjs')).href;
    const sourceModuleUrl = pathToFileURL(join(cliRoot, 'src', 'plugins', 'authoring', 'sourceModule.ts')).href;
    const activationUrl = pathToFileURL(join(cliRoot, 'src', 'plugins', 'runtime', 'lifecycle', 'activation', 'activateContributionModule.ts')).href;
    const bundlerUrl = pathToFileURL(join(cliRoot, 'src', 'plugins', 'authoring', 'bundleDaemonRuntime.ts')).href;
    const generatorUrl = pathToFileURL(join(cliRoot, 'scripts', 'build-owned', 'generateBundledPluginEntries.ts')).href;
    const sharedPackagesUrl = pathToFileURL(join(cliRoot, 'scripts', 'pluginHostSharedRuntimePackages.mjs')).href;
    const implementationUrl = pathToFileURL(join(pluginRoot, 'src', 'agent', 'runtime', implementation)).href;

    await withTempDir('happier-agent-runtime-demand-', async tempDir => {
      const observationsPath = join(tempDir, 'loaded-modules.ndjson');
      const observerPath = join(tempDir, 'observe-loads.mjs');
      const probePath = join(tempDir, 'runtime-demand.mjs');
      const stagedRoot = join(tempDir, 'staged');
      await mkdir(stagedRoot);
      await writeModuleLoadObserver(observerPath, observationsPath);
      await writeFile(probePath, [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        'import { register } from "node:module";',
        'import { createRequire } from "node:module";',
        'import { posix } from "node:path";',
        'import { pathToFileURL } from "node:url";',
        `register(${JSON.stringify(pathToFileURL(observerPath).href)}, { data: { output: ${JSON.stringify(observationsPath)} } });`,
        'const loaded = () => readFileSync(' + JSON.stringify(observationsPath) + ', "utf8").trim().split("\\n").filter(Boolean).map(line => new URL(JSON.parse(line)).href.split("?")[0]);',
        `const implementationUrl = ${JSON.stringify(implementationUrl)};`,
        `await import(${JSON.stringify(pathToFileURL(join(pluginRoot, 'src', 'manifest.ts')).href)});`,
        'assert.ok(!loaded().includes(implementationUrl), "manifest import eagerly loaded executable runtime before factory invocation: " + implementationUrl);',
        `const { evaluatePluginAuthorStagingSource, resolvePluginAuthorStagingModule } = await import(${JSON.stringify(sourceModuleUrl)});`,
        `const { activateContributionModule } = await import(${JSON.stringify(activationUrl)});`,
        `const rootPath = ${JSON.stringify(pluginRoot)};`,
        'const source = await evaluatePluginAuthorStagingSource({',
        '  locator: rootPath + "/src/index.ts", rootPath,',
        '  loadModule: async entryPath => await import(pathToFileURL(entryPath).href),',
        '});',
        'const activation = await activateContributionModule({',
        '  pluginId: source.evaluated.manifest.id, manifestAuthority: "bundled_first_party",',
        '  occurrenceId: "runtime-demand-probe", manifest: source.evaluated.manifest,',
        '  moduleNamespace: source.evaluated.module, isOccurrenceCurrent: () => true,',
        '  resolveRelativeModule: async module => await resolvePluginAuthorStagingModule({ graph: source.graph, module }),',
        '});',
        'try {',
        '  assert.equal(activation.status, "active", JSON.stringify(activation.diagnostics));',
        `  const registration = activation.registrations.find(row => row.family === "agents" && row.localId === ${JSON.stringify(agentId)});`,
        '  assert.ok(registration?.value.factory, "real Agent factory registration is required");',
        '  const locator = registration.value.sessionRunnerFactory;',
        '  assert.ok(locator?.externalSessionsExport, "External Sessions companion locator is required");',
        '  const leaf = await resolvePluginAuthorStagingModule({ graph: source.graph, module: locator.module });',
        '  assert.strictEqual(leaf.module[locator.export], registration.value.factory);',
        // Activation checks identity against the original registered companion;
        // its published registration intentionally contains a bounded snapshot.
        '  const companion = await import(pathToFileURL(rootPath + "/src/agent/surfaces/sessions/external/contribution.ts").href);',
        '  assert.strictEqual(leaf.module[locator.externalSessionsExport], companion[locator.externalSessionsExport]);',
        '  assert.ok(registration.value.externalSessions, "activated External Sessions projection is required");',
        '  assert.ok(!loaded().includes(implementationUrl), "catalog activation eagerly loaded executable runtime before factory invocation: " + implementationUrl);',
        '  const lifetime = new AbortController();',
        '  const runtime = await registration.value.factory({',
        '    plugin: { id: source.evaluated.manifest.id, version: source.evaluated.manifest.version },',
        `    agent: { id: ${JSON.stringify(agentId)} }, signal: lifetime.signal,`,
        '  });',
        '  assert.equal(typeof runtime.sessions?.open, "function", "first factory invocation must return the real session runtime");',
        '  assert.ok(loaded().includes(implementationUrl), "first factory invocation must load the executable implementation");',
        '  lifetime.abort();',
        // Stage through the publication owner, observing the real esbuild
        // result without changing its options or emitted graph.
        `  const { stagePluginDaemonRuntime } = await import(${JSON.stringify(bundlerUrl)});`,
        `  const { selectCanonicalRuntimeWorkspacePackageRoots } = await import(${JSON.stringify(generatorUrl)});`,
        `  const { PLUGIN_HOST_SHARED_RUNTIME_PACKAGES } = await import(${JSON.stringify(sharedPackagesUrl)});`,
        '  const { resolveWorkspaceBundlesFromPackageJson } = await import("@happier-dev/cli-common/workspaces");',
        `  const cliRoot = ${JSON.stringify(cliRoot)};`,
        `  const repoRoot = ${JSON.stringify(repoRoot)};`,
        '  const require = createRequire(pathToFileURL(cliRoot + "/package.json"));',
        '  const { build } = await import(pathToFileURL(require.resolve("esbuild")).href);',
        '  let metafile;',
        '  await stagePluginDaemonRuntime({',
        '    sourceRootPath: rootPath, sourceEntryPath: rootPath + "/src/index.ts",',
        `    stagedRootPath: ${JSON.stringify(stagedRoot)},`,
        '    daemonEntrypoint: source.evaluated.manifest.entrypoints.daemon,',
        '    sessionRunnerFactories: activation.validatedAgentSessionRunnerFactories,',
        '    canonicalWorkspacePackageRoots: selectCanonicalRuntimeWorkspacePackageRoots(resolveWorkspaceBundlesFromPackageJson({ repoRoot, hostPackageDir: cliRoot })),',
        '    firstPartyPackagedWorkspaceExternals: PLUGIN_HOST_SHARED_RUNTIME_PACKAGES,',
        '  }, { build: async options => { const result = await build(options); metafile = result.metafile; return result; } });',
        '  assert.ok(metafile, "canonical staging must produce a real emitted graph");',
        '  const outputs = metafile.outputs;',
        `  const implementationSuffix = ${JSON.stringify('/agent/runtime/' + implementation)};`,
        '  const heavyOutputs = Object.entries(outputs).filter(([, output]) => Object.entries(output.inputs).some(([input, detail]) => input.replaceAll("\\\\", "/").endsWith(implementationSuffix) && detail.bytesInOutput > 0)).map(([path]) => path);',
        '  assert.ok(heavyOutputs.length > 0, "staging must retain nonzero executable implementation bytes");',
        '  const runnerFact = activation.validatedAgentSessionRunnerFactories.find(fact => fact.localAgentId === registration.localId);',
        '  assert.ok(runnerFact, "activation must validate the real runner leaf");',
        '  const entries = Object.entries(outputs).filter(([, output]) => output.entryPoint && (output.entryPoint.endsWith("/src/index.ts") || output.entryPoint.endsWith("/" + runnerFact.normalizedModulePath))).map(([path]) => path);',
        '  assert.equal(entries.length, 2, "daemon and runner leaf must remain distinct emitted entrypoints");',
        '  const reachable = includeDynamic => {',
        '    const seen = new Set(); const pending = [...entries];',
        '    while (pending.length) {',
        '      const path = pending.pop(); if (seen.has(path)) continue; seen.add(path);',
        '      for (const dependency of outputs[path].imports) {',
        '        if (dependency.external || (!includeDynamic && dependency.kind === "dynamic-import")) continue;',
        '        const target = Object.hasOwn(outputs, dependency.path) ? dependency.path : posix.normalize(posix.join(posix.dirname(path), dependency.path));',
        '        assert.ok(Object.hasOwn(outputs, target), "emitted internal import must resolve: " + dependency.path);',
        '        pending.push(target);',
        '      }',
        '    } return seen;',
        '  };',
        '  const eager = reachable(false); const onUse = reachable(true);',
        '  for (const path of heavyOutputs) { assert.ok(!eager.has(path), "emitted executable implementation remains eager: " + path); assert.ok(onUse.has(path), "on-use executable chunk is unreachable: " + path); }',
        '  for (const [path, output] of Object.entries(outputs)) { if (Object.keys(output.inputs).length > 0) assert.ok(onUse.has(path), "staged executable output is orphaned: " + path); }',
        '  process.stdout.write(JSON.stringify({ agentId: registration.localId, heavyOutputs: heavyOutputs.length, eagerOutputs: eager.size, onUseOutputs: onUse.size }) + "\\n");',
        '  process.stdout.write("runtime-demand-verified\\n");',
        '} finally { await activation.dispose(); }',
      ].join('\n'), 'utf8');

      const child = spawnTestProcess(process.execPath, ['--import', sourceRuntimeUrl, probePath], {
        cwd: cliRoot,
        env: { ...process.env, TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const closed = once(child, 'close');
      const diagnostics: string[] = [];
      child.stdout?.on('data', chunk => diagnostics.push(String(chunk)));
      child.stderr?.on('data', chunk => diagnostics.push(String(chunk)));
      onTestFailed(() => console.error(diagnostics.join('')));
      onTestFinished(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await closed;
        }
      });
      const [code] = await closed;
      expect(code, diagnostics.join('')).toBe(0);
      expect(diagnostics.join('')).toContain('runtime-demand-verified');
    });
  }, 120_000);
});

describe('first-party GitHub Action demand', () => {
  it('keeps Triage execution unloaded through root activation and loads the real registered Action on first use', async () => {
    const cliRoot = projectPath();
    const repoRoot = join(cliRoot, '..', '..');
    const pluginRoot = join(repoRoot, 'packages', 'plugins', 'scm-github');
    const sourceRuntimeUrl = pathToFileURL(join(repoRoot, 'packages', 'cli-common', 'registerSourceRuntime.mjs')).href;
    await withTempDir('happier-github-action-demand-', async tempDir => {
      const observationsPath = join(tempDir, 'loaded-modules.ndjson');
      const observerPath = join(tempDir, 'observe-loads.mjs');
      const probePath = join(tempDir, 'action-demand.mjs');
      await writeModuleLoadObserver(observerPath, observationsPath);
      await writeFile(probePath, [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        'import { register } from "node:module";',
        `register(${JSON.stringify(pathToFileURL(observerPath).href)}, { data: { output: ${JSON.stringify(observationsPath)} } });`,
        'const loaded = () => readFileSync(' + JSON.stringify(observationsPath) + ', "utf8").trim().split("\\n").filter(Boolean).map(line => new URL(JSON.parse(line)).href.split("?")[0]);',
        `const operations = ${JSON.stringify(['operations.ts', 'detailOperations.ts', 'mutationOperations.ts'].map(name => pathToFileURL(join(pluginRoot, 'src', 'triage', name)).href))};`,
        `const plugin = await import(${JSON.stringify(pathToFileURL(join(pluginRoot, 'src', 'index.ts')).href)});`,
        'assert.deepEqual(operations.filter(url => loaded().includes(url)), [], "root import must not execute unrelated Triage leaves");',
        'const { createPluginTestkit } = await import("@happier-dev/plugin-sdk/testing");',
        'const { TriageListInstancesResultV1Schema } = await import("@happier-dev/triage-protocol/v1");',
        'const testkit = await createPluginTestkit({ manifest: plugin.manifest, module: { activate: plugin.activate } });',
        'try {',
        '  assert.equal(typeof testkit.registration("backgroundServices", "automation-repository-event-checkpointed-pull"), "function", "the Event observer remains registered");',
        '  assert.deepEqual(operations.filter(url => loaded().includes(url)), [], "activation must not execute unrelated Triage leaves");',
        '  const result = await testkit.invokeAction("triage/list-github-instances", { v: 1 });',
        '  assert.ok(TriageListInstancesResultV1Schema.safeParse(result).success, "the real first-use Action must return its published result");',
        '  assert.ok(loaded().includes(operations[0]), "the registered Action must load its real execution leaf");',
        '  assert.ok(!loaded().includes(operations[1]) && !loaded().includes(operations[2]), "discovery must not load detail or mutation execution");',
        '  process.stdout.write("github-action-demand-verified\\n");',
        '} finally { await testkit.dispose(); }',
      ].join('\n'), 'utf8');
      const child = spawnTestProcess(process.execPath, ['--import', sourceRuntimeUrl, probePath], {
        cwd: cliRoot,
        env: { ...process.env, TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const closed = once(child, 'close');
      const diagnostics: string[] = [];
      child.stdout?.on('data', chunk => diagnostics.push(String(chunk)));
      child.stderr?.on('data', chunk => diagnostics.push(String(chunk)));
      onTestFailed(() => console.error(diagnostics.join('')));
      onTestFinished(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await closed;
        }
      });
      const [code] = await closed;
      expect(code, diagnostics.join('')).toBe(0);
      expect(diagnostics.join('')).toContain('github-action-demand-verified');
    });
  }, 120_000);
});
