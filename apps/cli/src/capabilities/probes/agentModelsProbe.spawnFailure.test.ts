import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { withTempDir } from '@/testkit/fs/tempDir';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

describe('configured Agent model-probe launch failures', () => {
  it.each(process.platform === 'win32' ? ['ENOENT'] as const : ['ENOENT', 'EACCES'] as const)('projects %s without executable paths or error prose', async errno => {
    await withTempDir('happier-probe-spawn-', async cwd => {
      const previous = getActiveAccountSettingsSnapshot();
      const settings = accountSettingsParse({});
      const command = join(cwd, 'private-agent-command');
      if (errno === 'EACCES') { writeFileSync(command, 'not executable'); chmodSync(command, 0o600); }
      const acpCatalog = { status: 'ready' as const, revision: 1, record: { v: 1 as const, definitions: [{
        id: 'configured-agent', name: 'Agent', title: 'Agent',
        launch: { kind: 'command' as const, command, args: [] }, env: {},
        capabilities: { supportsLoadSession: false, supportsModes: 'unknown' as const, supportsModels: 'yes' as const,
          supportsConfigOptions: 'unknown' as const, promptImageSupport: 'no' as const }, createdAt: 1, updatedAt: 1,
      }] } };
      setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
        settingsSecretsReadKeys: [], scopeKey: 'spawn-probe-account', acpCatalog });
      resetAgentModelsProbeCacheForTests();
      try {
        // Real process/ACP boundary; catalog admission, probe and strict consumer remain real.
        const observation = AgentModelsProbeObservationSchema.parse(await probeAgentModelsBestEffort({ agentId: 'customAcp', cwd,
          accountSettings: settings, acpCatalogSnapshot: acpCatalog,
          backendTarget: { kind: 'configuredAcpBackend', backendId: 'configured-agent' } }));
        expect(observation).toMatchObject({ source: 'unavailable', availableModels: [], refreshError: true,
          spawnFailure: { reason: 'other', errno } });
        expect(JSON.stringify(observation)).not.toContain(command);
      } finally {
        resetAgentModelsProbeCacheForTests();
        if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
      }
    });
  });
});
