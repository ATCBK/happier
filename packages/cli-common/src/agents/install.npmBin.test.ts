import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { installAgentCliForRuntime, resolvePlatformFromNodePlatform } from './install.js';
import { resolveAgentCliManagedCommandPathForRuntime, type AgentCliRuntimeDescriptor } from './resolution.js';

describe('managed npm package executable selection', () => {
  it.each([
    { bins: { 'actual-cli': 'cli.js' }, bin: undefined, expected: 'actual-cli' },
    { bins: { first: 'first.js', second: 'second.js' }, bin: undefined, expected: null },
    { bins: { first: 'first.js', second: 'second.js' }, bin: 'second', expected: 'second' },
    { bins: 'cli.js', bin: undefined, expected: 'agent' },
  ])('uses the declared executable and refuses ambiguous bins ($expected)', async ({ bins, bin, expected }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-managed-npm-bin-'));
    try {
      const pnpm = join(root, 'pnpm');
      await writeFile(pnpm, '#!/bin/sh\nexit 0\n');
      await chmod(pnpm, 0o755);
      const env = { ...process.env, HAPPIER_HOME_DIR: root, HAPPIER_PNPM_BIN: pnpm, HAPPIER_JS_RUNTIME_PATH: process.execPath };
      const runtimeSpec: AgentCliRuntimeDescriptor = {
        id: 'acp.fixture', title: 'Fixture', binaryName: 'agent', sourcePreferenceDefault: 'managed-first',
        managedInstall: { kind: 'managed_package', packageName: '@fixture/agent@1.2.3', binaryName: 'agent',
          packageBinarySetup: { kind: 'npm_package_bin', packageName: '@fixture/agent', version: '1.2.3', ...(bin ? { bin } : {}) } },
        manualInstallKind: 'none', manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false,
      };
      const result = await installAgentCliForRuntime({
        runtimeSpec, env, platform: resolvePlatformFromNodePlatform(process.platform)!, skipIfInstalled: false,
        deps: {
          // Package-manager process is the genuine external boundary; real staging and promotion run below it.
          execFileWithDeadline: async (_command, args) => {
            const workspace = args[1]!;
            await mkdir(join(workspace, 'node_modules', '@fixture', 'agent'), { recursive: true });
            await writeFile(join(workspace, 'node_modules', '@fixture', 'agent', 'package.json'), JSON.stringify({ name: '@fixture/agent', version: '1.2.3', bin: bins }));
            await mkdir(join(workspace, 'node_modules', '.bin'), { recursive: true });
            for (const name of typeof bins === 'string' ? ['agent'] : Object.keys(bins)) {
              const path = join(workspace, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
              await writeFile(path, '#!/bin/sh\nexit 0\n'); await chmod(path, 0o755);
            }
            return { stdout: '', stderr: '' };
          },
        },
      });
      expect(result.ok).toBe(expected !== null);
      if (expected) expect(await readFile(resolveAgentCliManagedCommandPathForRuntime(runtimeSpec, { processEnv: env }), 'utf8')).toContain(join('.bin', process.platform === 'win32' ? `${expected}.cmd` : expected));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
