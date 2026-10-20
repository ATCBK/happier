import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import { readStoredCredentials } from '@/persistence';
import { resolveProjectSetupAcceptedWorkspace } from '@/workspaces/projectSetup/projectSetupAcceptedWorkspace';

import { withForegroundProviderFixture } from './prepareForegroundAdmission.providers.testkit';

afterEach(() => vi.restoreAllMocks());

describe('cold foreground Project launch preparation', () => {
  it('refuses a required child before Provider materialization or Agent bootstrap', async () => {
    await withForegroundProviderFixture({ configFileAgent: true, projectManifest: {
      version: 1, devcontainer: { configPath: '.devcontainer/devcontainer.json' },
    } }, async fixture => {
      const credentials = await readStoredCredentials();
      if (!credentials) throw new Error('Foreground fixture credentials are unavailable');
      const association = await resolveProjectSetupAcceptedWorkspace({ credentials,
        serverId: configuration.activeServerId, serverHttpBaseUrl: configuration.serverUrl,
        address: { serverId: configuration.activeServerId, workspaceId: 'foreground-workspace',
          machineId: 'machine-1', rootPath: fixture.directory },
      });
      expect(association.workspace.projectKey).toBe('foreground-project');
      // Explicit invalid wire input remains visible to the strict contract;
      // only the fixture's inferred revision follows an omitted Profile.
      expect(() => fixture.request({ profileId: undefined, profileRecordRevision: 1 })).toThrow();
      // This case selects a Provider, not a Launch Profile. Profile catalog
      // migration/readiness is a separate precondition from Project namespace.
      const admitted = await fixture.prepare({ profileId: undefined,
        accountSettingsScopeKey: undefined, accountSettingsVersion: undefined });
      expect(admitted).toMatchObject({ ok: false, error: { code: 'project_agent_launch_refused', reason: 'child_required' } });
      expect(await fixture.bootstrapFiles()).toEqual([]);
      expect(fixture.runtime.registry.activatedPluginIds.has(fixture.agentPluginId)).toBe(false);
    });
  });
});
