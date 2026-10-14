import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { ACCOUNT_SECURITY_PATH_V1 } from '@happier-dev/protocol/auth/accountSecurity';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot, readAccountRoleOverridesFromSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { prepareRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

const axiosGet = vi.hoisted(() => vi.fn());

vi.mock('axios', async (importOriginal) => {
  const original = await importOriginal<typeof import('axios')>();
  return { ...original, default: { ...original.default, get: axiosGet } };
});

afterEach(() => {
  resetInMemoryAccountSettingsContextForTests();
  axiosGet.mockReset();
  vi.unstubAllEnvs();
});

describe('credentialed Action policy binding before settings bootstrap', () => {
  it('hydrates Role admission into the admitted requester snapshot rather than the ambient Account', async () => {
    resetInMemoryAccountSettingsContextForTests();
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester-role-owner' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    const base = 'https://requester-role-home.example.invalid';
    // HTTP and installed-Machine currentness are the external boundaries;
    // requester bootstrap, captured catalogs and the Action factory stay real.
    axiosGet.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 404, data: {} };
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'requester-role-owner' } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows:
        PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain', v:
          key === 'role-overrides' ? { key, value: { v: 1, overrides: { scout: { roleId: 'scout',
            instructionsOverride: 'Use the requester override.' } } } } : emptyPromptLibraryRecordV1(key) } })) } };
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      throw new Error(`Unexpected requester Role HTTP read ${path}`);
    });
    await runWithServerHttpBaseUrl(base, async () => {
      const prepared = await prepareRequesterSessionBootstrap({ credentials,
        attribution: { serverId: 'requester-home', accountId: 'requester-role-owner', machineId: 'requester-machine', installationId: 'requester-installation' },
        boundary: { serverId: 'requester-home', serverHttpBaseUrl: base, happyHomeDir: '/tmp/cli-requester-role-fixture' },
        verifyMachineAdmissionCurrent: async () => true });
      expect(prepared).not.toBeNull();
      if (!prepared) throw new Error('Requester fixture admission failed');
      const bootstrap = prepared.admitted;
      const ambient = { scopeKey: 'another-account', source: 'network' as const, loadedAtMs: 1,
        settingsVersion: 1, settingsSecretsReadKeys: [], settings: accountSettingsParse({}) };
      setActiveAccountSettingsSnapshot(ambient);
      const installedAmbient = getActiveAccountSettingsSnapshot();
      const readSnapshot = () => {
        const snapshot = bootstrap.savedSecretOperationContext.readSnapshot();
        if (!snapshot) throw new Error('Requester snapshot retired');
        return snapshot;
      };
      try {
        const executor = createCliActionExecutorFromCredentials({ credentials, requesterSessionBootstrap: bootstrap,
          actionsSettingsProvider: {
            getActionsSettings: () => normalizeActionsSettingsV1(readSnapshot().settings.actionsSettingsV1),
            getAccountSettings: () => readSnapshot().settings,
            getAccountRoleOverrides: () => readAccountRoleOverridesFromSnapshot(readSnapshot()),
          }, readCredentials: async () => await bootstrap.isCurrent() ? credentials : null,
          pluginActionExecutionOwner: 'current_process' });
        const result = await executor.execute('roles.get', { roleId: 'scout' }, { surface: 'cli', authority: 'present_user' });
        expect(result.ok ? { ok: true } : result).toEqual({ ok: true });
        expect(result).toMatchObject({ ok: true, result: { roleId: 'scout' } });
        expect(readAccountRoleOverridesFromSnapshot(readSnapshot())).toMatchObject({ status: 'ready',
          overrides: { scout: { roleId: 'scout', instructionsOverride: 'Use the requester override.' } } });
        expect(getActiveAccountSettingsSnapshot()).toBe(installedAmbient);
      } finally { await prepared.cleanupOnFailure(); }
    });
  });
  it.each(['execute', 'prepare'] as const)('reads Account Role overrides on a cold %s invocation', async method => {
    resetInMemoryAccountSettingsContextForTests();
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: `cold-role-${method}` })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    // Home HTTP is the boundary; bootstrap, catalog hydration, role resolution
    // and Action preparation/execution all use their real canonical owners.
    axiosGet.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 404, data: {} };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows:
        PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain', v:
          key === 'role-overrides' ? { key, value: { v: 1, overrides: { scout: { roleId: 'scout',
            instructionsOverride: 'Use the Account override.' } } } } : emptyPromptLibraryRecordV1(key) } })) } };
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      throw new Error(`Unexpected cold Role HTTP read ${path}`);
    });
    const executor = createCliActionExecutorFromCredentials({ credentials, pluginActionExecutionOwner: 'current_process' });
    const context = { surface: 'cli', authority: 'present_user' } as const;
    const result = method === 'execute' ? await executor.execute('roles.list', {}, context)
      : await (async () => {
        const prepared = await executor.prepare('roles.list', {}, context);
        expect(prepared.kind).toBe('ready');
        return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
      })();
    expect(result).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
      expect.objectContaining({ roleId: 'scout' }),
    ]) } });
    // Catalog contents belong to the captured operation (covered above), not a
    // second ambient publication. Cold callers must still admit both reads.
    expect(await executor.execute('roles.get', { roleId: 'scout' }, context)).toMatchObject({ ok: true,
      result: { roleId: 'scout' } });
  });
  it.each(['execute', 'prepare'] as const)(
    'uses an explicit reviewed policy for %s without bootstrapping ambient Account settings',
    async (method) => {
      vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
      const executor = createCliActionExecutorFromCredentials({
        credentials: {
          token: `scoped-reviewed-policy-${method}`,
          encryption: null,
          credentialProvenance: 'stored_session',
        },
        actionsSettingsProvider: {
          getActionsSettings: () => normalizeActionsSettingsV1({
            v: 1,
            actions: { 'action.spec.get': { enabled: false } },
          }),
        },
        pluginActionExecutionOwner: 'current_process',
      });

      const result = method === 'execute'
        ? await executor.execute('action.spec.get', { id: 'session.list' }, { surface: 'cli' })
        : await executor.prepare('action.spec.get', { id: 'session.list' }, { surface: 'cli' });

      expect(result).toMatchObject(method === 'execute'
        ? { ok: false, errorCode: 'action_disabled' }
        : { kind: 'settled', result: { ok: false, errorCode: 'action_disabled' } });
      expect(axiosGet).not.toHaveBeenCalled();
    },
  );

  it.each([
    { initial: 'empty', kind: 'fixed', method: 'execute' },
    { initial: 'other_account', kind: 'fixed', method: 'prepare' },
    { initial: 'empty', kind: 'refreshing', method: 'execute' },
    { initial: 'other_account', kind: 'refreshing', method: 'prepare' },
  ] as const)('awaits $kind credential policy before $method with an initially $initial snapshot', async ({ initial, kind, method }) => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    resetInMemoryAccountSettingsContextForTests();
    const credentials = {
      token: `alice-policy-token-${kind}-${method}-${initial}`,
      encryption: null,
      credentialProvenance: 'stored_session' as const,
    };
    if (initial === 'other_account') {
      setActiveAccountSettingsSnapshot({ scopeKey: 'bob', source: 'network', loadedAtMs: Date.now(),
        settingsVersion: 1, settingsSecretsReadKeys: [], settings: accountSettingsParse({}) });
    }
    let resolvePolicyRequest!: (response: unknown) => void;
    // HTTP is the boundary. The real policy owner first reads Account Security;
    // only the Settings request is held pending by this admission fixture.
    axiosGet.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 404, data: { error: 'not_found' } };
      if (path === '/v2/account/settings') {
        return await new Promise((resolve) => { resolvePolicyRequest = resolve; });
      }
      throw new Error(`Unexpected policy fixture HTTP read ${path}`);
    });
    const executor = createCliActionExecutorFromCredentials({
      credentials,
      ...(kind === 'refreshing' ? { readCredentials: async () => credentials } : {}),
      pluginActionExecutionOwner: 'current_process',
    });

    const pending = method === 'execute'
      ? executor.execute('action.spec.get', { id: 'session.list' }, { surface: 'cli' })
      : executor.prepare('action.spec.get', { id: 'session.list' }, { surface: 'cli' });
    await vi.waitFor(() => expect(resolvePolicyRequest).toEqual(expect.any(Function)));
    let settled = false;
    void pending.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolvePolicyRequest({ status: 200, data: { version: 2, content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, actions: { 'action.spec.get': { enabled: false } } },
    } } } });
    await vi.waitFor(() => expect(getActiveAccountSettingsSnapshot()).toMatchObject({
      scopeKey: resolveAccountSettingsScopeKey(credentials),
      settingsVersion: 2,
      settings: { actionsSettingsV1: { actions: { 'action.spec.get': { enabled: false } } } },
    }));
    await expect(pending).resolves.toMatchObject(method === 'execute'
      ? { ok: false, errorCode: 'action_disabled' }
      : { kind: 'settled', result: { ok: false, errorCode: 'action_disabled' } });
  });
});
