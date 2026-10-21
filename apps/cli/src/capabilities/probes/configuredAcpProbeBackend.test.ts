import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, formatSharedSavedSecretRefV1, FeaturesResponseSchema,
  sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { setActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests, commitActiveAcpCatalog,
  getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createConfiguredAcpProbeBackend } from './configuredAcpProbeBackend';
import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';
import { probeAgentModesBestEffort } from './agentModesProbe';
import { createPreflightCatalogCleanupScope } from './preflightCatalogCleanupScope';
import { withAgentPreflightCatalog } from './withAgentPreflightCatalog';

// Exercise the real constructor without charging cold module loading to a probe test.
await import('@/agent/acp/catalog/configured/createConfiguredAcpBackend');

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });
const scopeKey = resolveAccountSettingsScopeKey({ token: 'probe-backend-scope', encryption: null });

function admitProbeSecret(home: string, removed: boolean) {
  // Only genuine Home HTTP boundaries are substituted; the catalog reader,
  // admission policy and materializer run their real implementations.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
    expect(String(input)).toBe(`${home}/v1/features/authenticated`);
    return new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: { teams: { enabled: true } }, capabilities: {},
    })), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    expect(String(url)).toBe(`${home}/v1/account/saved-secrets/resources/materials`);
    return { status: 200, data: SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
      resourceId: 'probe-resource', encryptionMode: 'plain', recipientEnvelope: null,
      entry: { ref: formatSharedSavedSecretRefV1('probe-resource'), source: 'shared_resource', relationship: 'owner',
        name: 'Probe token', kind: 'token', ownerAccountId: 'probe-owner', revision: 2,
        materialStatus: removed ? 'access_removed' : 'ready',
        capabilities: { use: !removed, rename: true, rotate: true, manageAccess: true, delete: true } },
      storedContent: removed ? null : sealSavedSecretResourceStoredContentV1({ resourceId: 'probe-resource', mode: 'plain',
        content: { v: 1, name: 'Probe token', kind: 'token', value: 'current-probe-token' } }),
    }] }) };
  });
}

function probeSnapshot(command: string, args: string[], home: string) {
  const credentials = { token: 'probe-owner-token', encryption: null } as const;
  const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), settingsVersion: 1,
    loadedAtMs: 1, settingsSecretsReadKeys: [],
    scopeKey: runWithServerHttpBaseUrl(home, () => resolveAccountSettingsScopeKey(credentials)),
    acpCatalog: { status: 'ready' as const, revision: 1, record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
      id: 'review-bot', name: 'review-bot', title: 'Review bot', launch: { kind: 'command' as const, command: command, args: args },
      env: { TOKEN: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('probe-resource') } },
      capabilities: {}, createdAt: 1, updatedAt: 1,
    }] }) }, savedSecretCatalogState: 'ready' as const,
    savedSecretResources: [{ resourceId: 'probe-resource', ownerAccountId: 'probe-owner', displayName: 'Probe token',
      kind: 'token' as const, encryptionMode: 'plain' as const, revision: 1, materialStatus: 'ready' as const,
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'probe-resource', mode: 'plain',
        content: { v: 1, name: 'Probe token', kind: 'token', value: 'cached-probe-token' } }) }],
  };
  return { credentials, snapshot };
}

describe('createConfiguredAcpProbeBackend', () => {
  it.each(['models', 'modes'] as const)('disposes a configured %s child before its containing preflight reports cancellation', async kind => {
    await withTempDir('happier-configured-cancel-', async directory => {
      const capture = join(directory, 'pending-pid');
      const script = writeAcpTestAgentScript({ dir: directory, fileName: 'pending-agent.mjs', source: `
        import { writeFileSync } from 'node:fs';
        let buffer = '';
        process.stdin.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const request = JSON.parse(line);
            if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
              result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }) + '\\n');
            if (request.method === 'session/new') writeFileSync(${JSON.stringify(capture)}, String(process.pid));
          }
        });
      ` });
      const settings = accountSettingsParse({});
      setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 1, loadedAtMs: 1,
        settingsSecretsReadKeys: [], scopeKey, acpCatalog: { status: 'ready', revision: 1,
          record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'review-bot', name: 'review-bot', title: 'Review bot',
            launch: { kind: 'command', command: process.execPath, args: [script] }, env: {}, createdAt: 1, updatedAt: 1,
          }] }),
        } });
      const controller = new AbortController();
      const cleanupScope = createPreflightCatalogCleanupScope();
      const params = { agentId: 'customAcp' as const,
        backendTarget: { kind: 'configuredAcpBackend' as const, backendId: 'review-bot' }, cwd: directory,
        accountSettings: settings, signal: controller.signal, cleanupScope, timeoutMs: 30_000 };
      const native = kind === 'models' ? probeAgentModelsBestEffort(params) : probeAgentModesBestEffort(params);
      const containing = withAgentPreflightCatalog(params, async () => await native);
      void containing.catch(() => undefined);
      let pid: number | undefined;
      try {
        await expect.poll(() => Number(readFileSync(capture, 'utf8'))).toBeGreaterThan(0);
        pid = Number(readFileSync(capture, 'utf8'));
        controller.abort(new Error('Containing preflight cancelled'));
        await expect(containing).rejects.toThrow('Containing preflight cancelled');
        expect(() => process.kill(pid!, 0)).toThrow();
      } finally {
        controller.abort();
        // The RED implementation does not retain this test-owned child.
        if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
        await cleanupScope.dispose();
        await native.catch(() => undefined);
      }
    });
  }, 60_000);

  it.each(['models', 'modes'] as const)('probes configured %s through the current catalog and refreshes after its launch environment changes', async kind => {
    await withTempDir('happier-configured-controls-', async directory => {
      const script = writeAcpTestAgentScript({ dir: directory, fileName: 'controls-agent.mjs', source: `
        let buffer = '';
        process.stdin.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const request = JSON.parse(line);
            const second = process.env.PROBE_VARIANT === 'second';
            const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
              : request.method === 'session/new' ? { sessionId: 'catalog-controls',
                models: { currentModelId: second ? 'model-b' : 'model-a', availableModels: [
                  { modelId: second ? 'model-b' : 'model-a', name: second ? 'Model B' : 'Model A' }] },
                modes: { currentModeId: second ? 'plan' : 'chat', availableModes: [
                  { id: second ? 'plan' : 'chat', name: second ? 'Plan' : 'Chat' }] } } : null;
            if (result) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
          }
        });
      ` });
      resetAgentModelsProbeCacheForTests();
      const settings = accountSettingsParse({});
      setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 1, loadedAtMs: 1,
        settingsSecretsReadKeys: [], scopeKey });
      const publish = (variant: 'first' | 'second') => expect(commitActiveAcpCatalog({ scopeKey,
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
        catalog: { status: 'ready', revision: variant === 'first' ? 1 : 2,
          record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
            id: 'review-bot', name: 'review-bot', title: 'Review bot',
            launch: { kind: 'command', command: process.execPath, args: [script] },
            env: { PROBE_VARIANT: { t: 'literal', v: variant } }, createdAt: 1, updatedAt: 1,
          }] }) },
      })).toBe(true);
      const params = { agentId: 'customAcp' as const,
        backendTarget: { kind: 'configuredAcpBackend' as const, backendId: 'review-bot' }, cwd: directory, accountSettings: settings };
      const probe = async () => kind === 'models' ? probeAgentModelsBestEffort(params) : probeAgentModesBestEffort(params);
      publish('first');
      const first = await probe();
      expect(first.source).toBe('dynamic');
      expect('availableModels' in first ? first.availableModels.map(row => row.id) : first.availableModes.map(row => row.id))
        .toContain(kind === 'models' ? 'model-a' : 'chat');
      expect(await probe()).toEqual(first);
      publish('second');
      const second = await probe();
      expect(second.source).toBe('dynamic');
      expect('availableModels' in second ? second.availableModels.map(row => row.id) : second.availableModes.map(row => row.id))
        .toContain(kind === 'models' ? 'model-b' : 'plan');
    });
  });
  it('expands machine values through the canonical resolver in a credentialless probe', async () => {
    await withTempDir('happier-configured-probe-literal-', async directory => {
      const outputPath = join(directory, 'probe-env.json');
      const script = writeAcpTestAgentScript({ dir: directory, fileName: 'probe-agent.mjs', source: `
        import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ REGION: process.env.REGION, LABEL: process.env.LABEL }));
        let buffer = '';
        process.stdin.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const request = JSON.parse(line);
            const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
              : request.method === 'session/new' ? { sessionId: 'literal-probe-session' } : null;
            if (result) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
          }
        });
      ` });
      const settings = accountSettingsParse({});
      setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 1, loadedAtMs: 1,
        settingsSecretsReadKeys: [], scopeKey, acpCatalog: { status: 'ready', revision: 1,
          record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'review-bot', name: 'review-bot', title: 'Review bot',
            launch: { kind: 'command', command: process.execPath, args: [script] },
            env: { REGION: { t: 'literal', v: '${PROBE_REGION}' }, LABEL: { t: 'template', template: 'Region {region}',
              vars: { region: { t: 'literal', v: '${PROBE_REGION}' } } } }, createdAt: 1, updatedAt: 1,
          }] }),
        } });
      const backend = await createConfiguredAcpProbeBackend({ agentId: 'customAcp',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' }, cwd: directory,
        accountSettings: settings, processEnv: { ...process.env, PROBE_REGION: 'eu' } });
      try {
        expect(await backend?.startSession()).toMatchObject({ sessionId: 'literal-probe-session' });
        expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({ REGION: 'eu', LABEL: 'Region eu' });
      } finally { await backend?.dispose(); }
    });
  });

  it('creates a literal-env configured probe from a ready facet without credentials', async () => {
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({
      source: 'network', settings, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey,
      acpCatalog: { status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
        id: 'review-bot', name: 'review-bot', title: 'Review bot', launch: { kind: 'command' as const, command: process.execPath, args: [] },
        env: { REGION: { t: 'literal', v: 'eu' } }, capabilities: {}, createdAt: 1, updatedAt: 1,
      }] }) },
    });
    const backend = await createConfiguredAcpProbeBackend({ agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' }, cwd: process.cwd(), accountSettings: settings });
    try { expect(backend).not.toBeNull(); }
    finally { await backend?.dispose(); }
  });

  it('refuses saved-secret launch materialization without credentials', async () => {
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({
      source: 'network', settings, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey,
      acpCatalog: { status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
        id: 'review-bot', name: 'review-bot', title: 'Review bot', launch: { kind: 'command' as const, command: process.execPath, args: [] },
        env: { TOKEN: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('secret-1') } }, capabilities: {}, createdAt: 1, updatedAt: 1,
      }] }) },
    });
    await expect(createConfiguredAcpProbeBackend({ agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' }, cwd: process.cwd(), accountSettings: settings }))
      .rejects.toMatchObject({ code: 'ACP_CATALOG_UNAVAILABLE', reason: 'credentials-unavailable' });
  });

  it('refuses an unscoped ready facet even for a literal-env credentialless probe', async () => {
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({
      source: 'network', settings, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      acpCatalog: { status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
        id: 'review-bot', name: 'review-bot', title: 'Review bot', launch: { kind: 'command' as const, command: process.execPath, args: [] },
        env: {}, capabilities: {}, createdAt: 1, updatedAt: 1,
      }] }) },
    });
    await expect(createConfiguredAcpProbeBackend({ agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' }, cwd: process.cwd(), accountSettings: settings }))
      .rejects.toMatchObject({ code: 'ACP_CATALOG_UNAVAILABLE' });
  });

  it('leaves bundled Agent probes at their existing owner', async () => {
    await expect(createConfiguredAcpProbeBackend({ agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, cwd: process.cwd() })).resolves.toBeNull();
  });

  it('refuses Home-revoked probe credentials even when the local material remains ready', async () => {
    const home = resolveServerHttpBaseUrl().replace(/\/+$/, '');
    const { credentials, snapshot } = probeSnapshot(process.execPath, [], home);
    setActiveAccountSettingsSnapshot(snapshot);
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
      serverHttpBaseUrl: home, isCurrent: async () => true });
    admitProbeSecret(home, true);
    const produced: { backend: Awaited<ReturnType<typeof createConfiguredAcpProbeBackend>> } = { backend: null };
    const creating = createConfiguredAcpProbeBackend({ agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' }, cwd: process.cwd(),
      credentials, accountSettings: snapshot.settings, savedSecretOperationContext: operationContext,
    }).then(backend => { produced.backend = backend; return backend; });
    try { await expect(creating).rejects.toMatchObject({ code: 'saved_secret_resolution_failed', status: 'forbidden' }); }
    finally { await produced.backend?.dispose(); }
  });

  it('launches the actual probe with material admitted through its captured foreign Home', async () => {
    await withTempDir('happier-configured-probe-home-', async directory => {
      const script = writeAcpTestAgentScript({ dir: directory, fileName: 'probe-agent.mjs', source: `
        import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(join(directory, 'probe-env.json'))}, JSON.stringify({ TOKEN: process.env.TOKEN }));
        let buffer = '';
        process.stdin.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const request = JSON.parse(line);
            if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }) + '\\n');
            if (request.method === 'session/new') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'probe-session' } }) + '\\n');
          }
        });
      ` });
      const home = 'https://captured-probe-home.test';
      const { credentials, snapshot } = probeSnapshot(process.execPath, [script], home);
      snapshot.acpCatalog.record.definitions[0]!.env = {
        TOKEN: { t: 'template', template: 'Bearer {key}', vars: {
          key: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('probe-resource') },
        } },
      };
      const operationContext = runWithServerHttpBaseUrl(home, () => createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
        serverHttpBaseUrl: home, isCurrent: async () => true }));
      const focused = { ...snapshot, scopeKey, acpCatalog: { status: 'ready' as const, revision: 99,
        record: { v: 1 as const, definitions: [] } } };
      setActiveAccountSettingsSnapshot(focused);
      const incumbent = getActiveAccountSettingsSnapshot();
      admitProbeSecret(home, false);
      const backend = await createConfiguredAcpProbeBackend({ agentId: 'customAcp',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' }, cwd: directory,
        credentials, accountSettings: snapshot.settings, savedSecretOperationContext: operationContext });
      try {
        expect(await backend?.startSession()).toMatchObject({ sessionId: 'probe-session' });
        expect(JSON.parse(readFileSync(join(directory, 'probe-env.json'), 'utf8'))).toEqual({ TOKEN: 'Bearer current-probe-token' });
        expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
      } finally { await backend?.dispose(); }
    });
  });
});
