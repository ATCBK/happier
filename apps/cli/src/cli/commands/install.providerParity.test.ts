import { describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({
    agents: [{
      id: 'acme-agent',
      provenance: 'external',
      source: { kind: 'package' },
      definition: { kindVersion: 1, id: 'acme-agent', ownedBackendIds: [] },
      runtimeSpec: {
        kindVersion: 1,
        id: 'acme-agent',
        title: 'Acme Agent CLI',
        binaryName: 'acme-agent',
        sourcePreferenceDefault: 'system-first',
        managedInstall: {
          kind: 'managed_package',
          packageName: '@acme/agent-cli',
          binaryName: 'acme-agent',
        },
        manualInstallKind: 'command',
        manualInstallRecipes: null,
        acceptsJavaScriptFileOverride: false,
      },
      catalogEntry: null,
    }],
  })),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  resolveMergedContributionRegistry: registry.resolve,
}));
vi.mock('@/plugins/store/paths', () => ({ resolvePluginStorePaths: () => ({ happyHomeDir: '/tmp/happier' }) }));
vi.mock('@/plugins/daemon/changeClient', () => ({
  requestUserPluginChange: vi.fn(),
  resolveUserPluginChangeApproval: vi.fn(),
}));
vi.mock('@/plugins/distribution/archive/integrity', () => ({ resolveArchiveExpectedIntegrity: vi.fn() }));
vi.mock('@/plugins/store/registry/currentState', () => ({ createPluginRegistryStateStore: vi.fn() }));
vi.mock('@/terminal/prompts/promptInput', () => ({ isInteractiveTerminal: () => false }));

import type { CommandContext } from '@/cli/commandRegistry';
import { runInstallCliCommand } from './install';

describe('happier install provider contribution parity', () => {
  it('plans an external Agent through the normalized CLI descriptor without installing it', async () => {
    const invokeAgentCliInstall = vi.fn(async () => ({
      ok: true as const,
      alreadyInstalled: false,
      logPath: null,
      plan: {
        agentId: 'acme-agent',
        title: 'Acme Agent CLI',
        binaries: ['acme-agent'],
        platform: 'linux' as const,
        docsUrl: null,
        commands: [],
        requiresAdmin: false,
        installMode: 'managed_package' as const,
        managedInstall: {
          kind: 'managed_package' as const,
          packageName: '@acme/agent-cli',
          binaryName: 'acme-agent',
        },
      },
    }));
    const context: CommandContext = {
      args: ['install', 'provider', 'acme-agent', '--dry-run'],
      rawArgv: ['happier', 'install', 'provider', 'acme-agent', '--dry-run'],
      terminalRuntime: null,
    };

    await runInstallCliCommand(context, {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn() as never,
      runDoctorCommand: vi.fn(),
      invokeAgentCliInstall,
    });

    expect(invokeAgentCliInstall).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'acme-agent',
      runtimeSpec: expect.objectContaining({
        id: 'acme-agent',
        title: 'Acme Agent CLI',
      }),
    }));
  });
});
