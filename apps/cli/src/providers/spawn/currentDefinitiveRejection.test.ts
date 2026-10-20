import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, DEFAULT_PROVIDER_SETTINGS_V1, ProviderContributionV1Schema, ProviderSettingsV1Schema } from '@happier-dev/protocol';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { resolveAgentNativeSpawnDefinitiveRejection, resolveCurrentProviderSpawnDefinitiveRejection } from './currentDefinitiveRejection';

describe('resolveCurrentProviderSpawnDefinitiveRejection', () => {
  it('uses an offered Provider model instead of a static native model catalog while retaining mode and syntax checks', () => {
    const input = { agentId: 'qwen', selection: { modelId: 'team-only-model', providerConnectionId: null },
      sourceModel: { id: 'team-only-model', name: 'Team model' } };
    const native = { ...input, sourceModel: undefined };
    const differentSourceModel = { ...input, sourceModel: { id: 'a-different-model', name: 'Different model' } };
    expect(resolveAgentNativeSpawnDefinitiveRejection(input)).toEqual({ ok: true });
    expect(resolveAgentNativeSpawnDefinitiveRejection(native)).toEqual({ ok: false });
    expect(resolveAgentNativeSpawnDefinitiveRejection(differentSourceModel)).toEqual({ ok: false });
    expect(resolveAgentNativeSpawnDefinitiveRejection({ ...input, selection: { ...input.selection,
      sessionConfigOptionOverrides: { v: 0 } } })).toEqual({ ok: false });
    expect(resolveAgentNativeSpawnDefinitiveRejection({ ...input, agentId: 'gemini',
      selection: { ...input.selection, acpSessionModeId: 'plan' } })).toEqual({ ok: false });
  });

  it('rejects a missing admitted connection without rejecting a valid route or an unavailable catalog', async () => {
    const provider = ProviderContributionV1Schema.parse({ v: 1, id: 'gateway', name: 'Gateway', kind: 'cloud',
      endpointTemplates: [{ id: 'responses', protocol: 'openai-responses', baseUrl: 'https://gateway.example/v1',
        capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } }],
      credential: { kind: 'apiKey', required: true, transports: [{ id: 'bearer', protocols: ['openai-responses'],
        uses: ['probe', 'runtime'], destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } }] },
      catalog: { source: 'static', manualModelPolicy: 'allowed', staticModels: [{ id: 'model', name: 'Model' }] },
    });
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
      manifest: createPluginManifestV2Fixture({ id: 'example.spawn-provider', contributes: { providers: [provider] } }),
      files: { 'daemon.mjs': 'export function activate() {}' },
    }] });
    try {
      resetActiveAccountSettingsSnapshotForTests();
      const providerSettings = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{ v: 1, id: 'pc_gateway',
        source: { kind: 'contribution', contributionKey: 'example.spawn-provider/gateway' }, role: 'default',
        displayName: 'Gateway', displayNameMode: 'automatic', revision: 1, createdAt: 1, updatedAt: 1 }] });
      const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'spawn-provider-account',
        providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog: splitProviderSettingsV1(providerSettings).catalog } };
      setActiveAccountSettingsSnapshot(snapshot);
      // Select the real controller for this private physical plugin fixture;
      // Account publication, catalog admission and cold decisions stay real.
      const deps = { getActiveAccountSettingsSnapshot,
        tryAcquireAuthoritativePluginRuntimeRegistryLease: () => runtime.controller.tryAcquireRuntimeRegistry() };
      const target = { agentId: 'codex' as const, agentTargetKey: 'backend:codex', deps };
      await expect(resolveCurrentProviderSpawnDefinitiveRejection({ ...target,
        selection: { providerConnectionId: 'pc_missing', modelId: 'model' } })).resolves.toEqual({ ok: false });
      await expect(resolveCurrentProviderSpawnDefinitiveRejection({ ...target,
        selection: { providerConnectionId: 'pc_gateway', modelId: 'model' } })).resolves.toMatchObject({ ok: true,
          ref: { providerConnectionId: 'pc_gateway', modelId: 'model' } });
      setActiveAccountSettingsSnapshot({ ...snapshot, settingsVersion: 2, providerConnectionsCatalog: { status: 'loading' } });
      await expect(resolveCurrentProviderSpawnDefinitiveRejection({ ...target,
        selection: { providerConnectionId: 'pc_missing', modelId: 'model' } })).resolves.toMatchObject({ ok: true });
    } finally {
      resetActiveAccountSettingsSnapshotForTests();
      await runtime.dispose();
    }
  });
  it.each([
    ['a static-only native model outside its catalog', 'qwen', { modelId: 'not-a-qwen' }],
    ['a mode for an Agent with no mode surface', 'gemini', { acpSessionModeId: 'plan' }],
    ['a malformed config-option override shape', 'codex', { sessionConfigOptionOverrides: { v: 0 } }],
  ] as const)('rejects %s without reading the Account or acquiring a plugin lease', async (_label, agentId, selection) => {
    const getActiveAccountSettingsSnapshot = vi.fn(() => null);
    const tryAcquireAuthoritativePluginRuntimeRegistryLease = vi.fn(() => {
      throw new Error('a deterministic native rejection must not acquire a runtime lease');
    });

    await expect(resolveCurrentProviderSpawnDefinitiveRejection({
      agentTargetKey: `backend:${agentId}`,
      agentId,
      selection,
      deps: {
        getActiveAccountSettingsSnapshot: getActiveAccountSettingsSnapshot as never,
        tryAcquireAuthoritativePluginRuntimeRegistryLease:
          tryAcquireAuthoritativePluginRuntimeRegistryLease as never,
      },
    })).resolves.toEqual({ ok: false });

    expect(getActiveAccountSettingsSnapshot).not.toHaveBeenCalled();
    expect(tryAcquireAuthoritativePluginRuntimeRegistryLease).not.toHaveBeenCalled();
  });

  it.each([
    ['the native default model', 'qwen', { modelId: 'default' }],
    ['a dynamic native model that cannot be known locally', 'codex', { modelId: 'future-model' }],
  ] as const)('keeps %s eligible for the ordinary launch owner', async (_label, agentId, selection) => {
    const result = await resolveCurrentProviderSpawnDefinitiveRejection({
      agentTargetKey: `backend:${agentId}`,
      agentId,
      selection,
      deps: {
        getActiveAccountSettingsSnapshot: (() => null) as never,
        tryAcquireAuthoritativePluginRuntimeRegistryLease: (() => null) as never,
      },
    });

    expect(result).toMatchObject({ ok: true });
  });
});
