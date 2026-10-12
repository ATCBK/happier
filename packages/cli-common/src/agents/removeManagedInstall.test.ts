import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { installAgentCliForRuntime, resolvePlatformFromNodePlatform } from './install.js';
import { resolveAgentCliManagedCommandPathForRuntime, type AgentCliRuntimeDescriptor } from './resolution.js';
import { managedAcpInstallId } from './managedAcpInstallIdentity.js';

it('records ACP identity in the host manifest, preserves vendor metadata and removes only the selected managed root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-acp-npm-removal-'));
  try {
    const pnpm = join(root, 'pnpm');
    await writeFile(pnpm, '#!/bin/sh\nexit 0\n'); await chmod(pnpm, 0o755);
    const env = { ...process.env, HAPPIER_HOME_DIR: root, HAPPIER_PNPM_BIN: pnpm, HAPPIER_JS_RUNTIME_PATH: process.execPath };
    const spec: AgentCliRuntimeDescriptor = { id: managedAcpInstallId({ accountId: 'alice', definitionId: 'fixture', version: '1.2.3' }), title: 'Fixture', binaryName: 'agent',
      sourcePreferenceDefault: 'managed-first', manualInstallKind: 'none', manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false,
      managedInstall: { kind: 'managed_package', packageName: '@fixture/agent@1.2.3', binaryName: 'agent',
        packageBinarySetup: { kind: 'npm_package_bin', packageName: '@fixture/agent', version: '1.2.3',
          managedAcpDefinition: { definitionId: 'fixture', title: 'Fixture' } } } };
    const vendor = { name: '@fixture/agent', version: '1.2.3', bin: { cli: 'cli.js' } };
    const installed = await installAgentCliForRuntime({ runtimeSpec: spec, platform: resolvePlatformFromNodePlatform(process.platform)!, env,
      skipIfInstalled: false, deps: { execFileWithDeadline: async (_command, args) => {
        // The package-manager process is external; canonical staging, bin selection and promotion remain real.
        const workspace = args[1]!;
        await mkdir(join(workspace, 'node_modules', '@fixture', 'agent'), { recursive: true });
        await writeFile(join(workspace, 'node_modules', '@fixture', 'agent', 'package.json'), JSON.stringify(vendor));
        const bin = join(workspace, 'node_modules', '.bin', process.platform === 'win32' ? 'cli.cmd' : 'cli');
        await mkdir(dirname(bin), { recursive: true }); await writeFile(bin, '#!/bin/sh\nexit 0\n'); await chmod(bin, 0o755);
        return { stdout: '', stderr: '' };
      } } });
    expect(installed.ok).toBe(true);
    const command = resolveAgentCliManagedCommandPathForRuntime(spec, { processEnv: env });
    const current = dirname(dirname(command));
    expect(JSON.parse(await readFile(join(current, 'workspace', 'package.json'), 'utf8'))).toMatchObject({
      happierManagedAcp: { definitionId: 'fixture', title: 'Fixture', kind: 'npm', version: '1.2.3' },
    });
    const { readManagedAgentCliInstallMetadata, removeAgentCliManagedInstallForRuntime } = await import('./removeManagedInstall.js');
    expect(await readManagedAgentCliInstallMetadata({ runtimeSpec: spec, env })).toEqual({ definitionId: 'fixture', title: 'Fixture', kind: 'npm', version: '1.2.3' });
    expect(JSON.parse(await readFile(join(current, 'workspace', 'node_modules', '@fixture', 'agent', 'package.json'), 'utf8'))).toEqual(vendor);
    await writeFile(join(root, 'system-agent'), 'user binary');
    const controller = new AbortController(); controller.abort();
    await expect(removeAgentCliManagedInstallForRuntime({ runtimeSpec: spec, env, signal: controller.signal })).rejects.toThrow();
    await access(command);
    expect(await removeAgentCliManagedInstallForRuntime({ runtimeSpec: spec, env })).toEqual({ ok: true });
    await expect(access(command)).rejects.toThrow();
    await access(join(root, 'system-agent'));
    expect(await removeAgentCliManagedInstallForRuntime({ runtimeSpec: spec, env })).toEqual({ ok: false, code: 'not_managed' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
