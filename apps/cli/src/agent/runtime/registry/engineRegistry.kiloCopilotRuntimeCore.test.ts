import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

type StageETier2Agent = Readonly<{
  backendId: 'kilo' | 'copilot';
  pluginId: string;
  packageName: string;
  displayName: string;
}>;

const STAGE_E_TIER2_AGENTS: readonly StageETier2Agent[] = Object.freeze([
  {
    backendId: 'kilo',
    pluginId: 'happier.agent.kilo',
    packageName: '@happier-dev/plugins-kilo',
    displayName: 'Kilo',
  },
  {
    backendId: 'copilot',
    pluginId: 'happier.agent.copilot',
    packageName: '@happier-dev/plugins-copilot',
    displayName: 'GitHub Copilot',
  },
]);

function createTestCredentials(): Credentials {
  return {
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(1),
    },
  };
}

describe('engineRegistry (Kilo/Copilot runtimeCore)', () => {
  it.each(STAGE_E_TIER2_AGENTS)(
    'resolves bundled $backendId ACP plugin runtimeCore through production dispatch',
    async (agent) => {
      const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
        contributes: createResolvedContributionRegistry(resolveBuiltInContributions()), pluginIds: [agent.pluginId],
      } });
      try {
        const resolution = await resolveBackendEngineAdapterResolution(agent.backendId, {
          runtimeRegistry: fixture.registry,
        });

        expect(resolution).toMatchObject({
          backendId: agent.backendId,
          agentId: agent.backendId,
          selectedSource: 'plugin',
          backend: {
            pluginId: agent.pluginId,
            daemonEntryPath: agent.packageName,
          },
        });

        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
          credentials: createTestCredentials(),
          directory: `/tmp/${agent.backendId}`,
          permissionMode: 'safe-yolo',
        });

        expect(plan).toMatchObject({
          kind: 'hostSessionRuntimePlan',
          agentId: agent.backendId,
          config: {
            backendDisplayName: agent.displayName,
            providerName: agent.displayName,
            agentMessageType: agent.backendId,
          },
        });
        expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));
      } finally {
        await fixture.dispose();
      }
    },
  );
});
