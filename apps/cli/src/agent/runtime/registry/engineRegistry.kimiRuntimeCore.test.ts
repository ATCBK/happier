import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const KIMI_BACKEND_ID = 'kimi';
const KIMI_PLUGIN_ID = 'happier.agent.kimi';

function createTestCredentials(): Credentials {
  return {
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(1),
    },
  };
}

describe('engineRegistry (kimi runtimeCore)', () => {
  it('resolves the bundled Kimi ACP plugin runtimeCore through production dispatch', async () => {
    const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
      contributes: createResolvedContributionRegistry(resolveBuiltInContributions()), pluginIds: [KIMI_PLUGIN_ID],
    } });
    try {
      const resolution = await resolveBackendEngineAdapterResolution(KIMI_BACKEND_ID, { runtimeRegistry: fixture.registry });

      expect(resolution).toMatchObject({
        backendId: 'kimi',
        agentId: 'kimi',
        selectedSource: 'plugin',
        backend: {
          pluginId: 'happier.agent.kimi',
          daemonEntryPath: '@happier-dev/plugins-kimi',
        },
      });

      const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
        credentials: createTestCredentials(),
        directory: '/tmp/kimi',
        permissionMode: 'read-only',
      });

      expect(plan).toMatchObject({
        kind: 'hostSessionRuntimePlan',
        agentId: 'kimi',
        config: {
          backendDisplayName: 'Kimi',
          providerName: 'Kimi',
          agentMessageType: 'kimi',
        },
      });
      expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));
    } finally {
      await fixture.dispose();
    }
  });
});
