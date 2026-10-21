import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema, type ActionExecuteResult } from '@happier-dev/protocol';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import * as control from '@/daemon/controlClient';
import * as publication from '@/daemon/multiDaemon';
import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

afterEach(() => vi.restoreAllMocks());

describe('original terminal Settings transport', () => {
  it('preserves explicit daemon ingress for prepared contributed input-type choices', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1', provenance: {
      v: 1, kind: 'account', authority: 'present_user',
    } })).toString('base64url')}.signature`;
    // OS publication and daemon HTTP are the system boundaries; preparation,
    // consuming-field admission and the options callback stay real.
    vi.spyOn(publication, 'resolveLiveDaemonControlTargetForServer').mockResolvedValue({
      pid: 123, httpPort: 4321, accountId: 'account-1', machineId: 'machine-1',
    });
    const definition = ActionDefinitionV1Schema.parse({
      kindVersion: 1, id: 'com.acme.inputs/actions/read', title: 'Read repository', description: 'Read repository',
      safety: 'safe', placements: [], slash: null, bindings: null, examples: null,
      surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false, api: true, plugin: true },
      inputHints: { fields: [{ path: 'repository', title: 'Repository', widget: 'select',
        inputType: { pluginId: 'com.acme.inputs', localId: 'repository' } }] },
      inputSchema: { type: 'object', properties: { repository: { type: 'string' } }, additionalProperties: false },
    });
    const input = { actionId: definition.id, fieldPath: 'repository' };
    const requests: unknown[] = [];
    const result = { actionId: definition.id, fieldPath: 'repository', optionsSourceId: null,
      options: [{ value: 'repo-one', label: 'One' }] };
    vi.spyOn(control, 'requestDaemonSignedRootActionExecution').mockImplementation(async (request, options) => {
      expect(options?.target).toMatchObject({ accountId: 'account-1', machineId: 'machine-1' });
      requests.push(request);
      return { ok: true, result };
    });
    const owner = createCliActionExecutorFromCredentials({
      credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
      serverId: 'home-1', serverApiUrl: 'https://home.example.test', serverIdentityId: 'srv_home',
      listContributedActionDefinitions: () => [definition],
      actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
    });
    const prepared = await owner.prepare('action.options.resolve', input, { surface: 'cli' });
    if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
    const actual = await prepared.invocation.run();
    expect(actual, JSON.stringify(actual)).toMatchObject({ ok: true, result });
    expect(requests).toEqual([{ actionId: 'action.options.resolve', input }]);
  });
  it.each(['terminal', 'account'] as const)('captures the own daemon route when a stored %s caller prepares a device setting read', async kind => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1', provenance: {
      v: 1, kind, authority: kind === 'terminal' ? 'account_automation' : 'present_user',
    } })).toString('base64url')}.signature`;
    const publicationBoundary = vi.spyOn(publication, 'resolveLiveDaemonControlTargetForServer').mockResolvedValue({
      pid: 123, httpPort: 4321, accountId: 'account-1', machineId: 'machine-1',
    });
    const result: ActionExecuteResult = { ok: true, result: { anchor: 'appearance.themeMode', value: 'dark' } };
    const requests: unknown[] = [];
    vi.spyOn(control, 'requestDaemonSignedRootActionExecution').mockImplementation(async (request, options) => {
      expect(options?.target).toMatchObject({ accountId: 'account-1', machineId: 'machine-1', httpPort: 4321 });
      requests.push(request);
      return result;
    });
    const owner = createCliActionExecutorFromCredentials({
      credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
      serverId: 'home-1', serverApiUrl: 'https://home.example.test', serverIdentityId: 'srv_home',
      externalActionClient: true,
      actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
    });
    const prepared = await owner.prepare('settings.get', { anchor: 'appearance.themeMode' }, {
      surface: 'cli', actionRequestId: 'device-setting-read',
    });
    expect(requests).toEqual([]);
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Device setting read did not prepare');
    publicationBoundary.mockResolvedValue({ pid: 456, httpPort: 9876, accountId: 'account-1', machineId: 'machine-2' });
    expect(await prepared.invocation.run()).toEqual(result);
    expect(await prepared.invocation.run()).toEqual(result);
    expect(requests).toEqual([{ actionId: 'settings.get', input: { anchor: 'appearance.themeMode' },
      actionRequestId: 'device-setting-read' }]);
  });
  it.each(['signed_out', 'account_changed'] as const)('does not issue a captured device read after its credentials retire: %s', async retirement => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1', provenance: {
      v: 1, kind: 'terminal', authority: 'account_automation',
    } })).toString('base64url')}.signature`;
    const credentials: StoredCredentials = { token, encryption: null, credentialProvenance: 'stored_session' };
    let current: StoredCredentials | null = credentials;
    vi.spyOn(publication, 'resolveLiveDaemonControlTargetForServer').mockResolvedValue({
      pid: 123, httpPort: 4321, accountId: 'account-1', machineId: 'machine-1',
    });
    const requests: unknown[] = [];
    vi.spyOn(control, 'requestDaemonSignedRootActionExecution').mockImplementation(async request => {
      requests.push(request);
      return { ok: true, result: { anchor: 'appearance.themeMode', value: 'dark' } };
    });
    const owner = createCliActionExecutorFromCredentials({
      credentials, readCredentials: async () => current,
      serverId: 'home-1', serverApiUrl: 'https://home.example.test', serverIdentityId: 'srv_home',
      externalActionClient: true,
      actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
    });
    const prepared = await owner.prepare('settings.get', { anchor: 'appearance.themeMode' }, { surface: 'cli' });
    if (prepared.kind !== 'ready') throw new Error('Device setting read did not prepare');
    current = retirement === 'signed_out' ? null : { ...credentials,
      token: `header.${Buffer.from(JSON.stringify({ sub: 'account-2', provenance: {
        v: 1, kind: 'terminal', authority: 'account_automation',
      } })).toString('base64url')}.signature` };
    expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'credential_scope_retired' });
    expect(requests).toEqual([]);
  });
  it.each(['signed_out', 'account_changed', 'cancelled', 'current'] as const)(
    'retains the captured device read scope across own-Machine endpoint discovery: %s', async scope => {
      const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1', provenance: {
        v: 1, kind: 'terminal', authority: 'account_automation',
      } })).toString('base64url')}.signature`;
      const credentials: StoredCredentials = { token, encryption: null, credentialProvenance: 'stored_session' };
      let current: StoredCredentials | null = credentials;
      const capturedTarget = { pid: 123, httpPort: 4321, accountId: 'account-1', machineId: 'machine-1' };
      const controlTarget = vi.spyOn(publication, 'resolveLiveDaemonControlTargetForServer').mockResolvedValue(capturedTarget);
      let releaseDiscovery: () => void = () => { throw new Error('Endpoint discovery was not pending'); };
      let discoveryStarted: () => void = () => { throw new Error('Endpoint discovery was not initialized'); };
      const started = new Promise<void>(resolve => { discoveryStarted = resolve; });
      // These adapters cross the OS publication and daemon HTTP boundaries.
      vi.spyOn(publication, 'resolveLiveDaemonExternalActionEndpoint').mockImplementation(async () => {
        discoveryStarted();
        await new Promise<void>(resolve => { releaseDiscovery = resolve; });
        return capturedTarget;
      });
      const result: ActionExecuteResult = { ok: true, result: { anchor: 'appearance.themeMode', value: 'dark' } };
      const requests: unknown[] = [];
      vi.spyOn(control, 'requestDaemonSignedRootActionExecution').mockImplementation(async (request, options) => {
        expect(options?.target).toEqual(capturedTarget);
        requests.push(request);
        return result;
      });
      const owner = createCliActionExecutorFromCredentials({
        credentials, readCredentials: async () => current,
        serverId: 'home-1', serverApiUrl: 'https://home.example.test', serverIdentityId: 'srv_home',
        externalActionClient: true,
        actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
      });
      const controller = new AbortController();
      const prepared = await owner.prepare('settings.get', { anchor: 'appearance.themeMode' }, {
        surface: 'cli', signal: controller.signal,
        externalActionTarget: { kind: 'machine', machineId: 'machine-1' }, actionRequestId: 'device-setting-read',
      });
      if (prepared.kind !== 'ready') throw new Error('Device setting read did not prepare');
      const running = prepared.invocation.run();
      expect(await Promise.race([
        started.then(() => 'discovery'),
        running.then(() => 'settled_without_discovery'),
      ])).toBe('discovery');
      expect(requests).toEqual([]);
      if (scope === 'signed_out') current = null;
      if (scope === 'account_changed') current = { ...credentials,
        token: `header.${Buffer.from(JSON.stringify({ sub: 'account-2', provenance: {
          v: 1, kind: 'terminal', authority: 'account_automation',
        } })).toString('base64url')}.signature` };
      if (scope === 'cancelled') controller.abort();
      controlTarget.mockResolvedValue({ ...capturedTarget, pid: 456, httpPort: 9876 });
      releaseDiscovery();
      const expected = scope === 'current' ? result : {
        ok: false, errorCode: scope === 'cancelled' ? 'cancelled' : 'credential_scope_retired',
      };
      expect(await running).toMatchObject(expected);
      expect(await prepared.invocation.run()).toMatchObject(expected);
      expect(requests).toEqual(scope === 'current' ? [{
        actionId: 'settings.get', input: { anchor: 'appearance.themeMode' },
        target: { kind: 'machine', machineId: 'machine-1' }, actionRequestId: 'device-setting-read',
      }] : []);
    },
  );
  it('does not issue a captured device read cancelled while its scope check is pending', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1', provenance: {
      v: 1, kind: 'terminal', authority: 'account_automation',
    } })).toString('base64url')}.signature`;
    const credentials: StoredCredentials = { token, encryption: null, credentialProvenance: 'stored_session' };
    let waitForScopeCheck = false;
    let releaseScopeCheck: () => void = () => { throw new Error('Scope check was not pending'); };
    let scopeCheckStarted: () => void = () => { throw new Error('Scope check was not initialized'); };
    const started = new Promise<void>(resolve => { scopeCheckStarted = resolve; });
    vi.spyOn(publication, 'resolveLiveDaemonControlTargetForServer').mockResolvedValue({
      pid: 123, httpPort: 4321, accountId: 'account-1', machineId: 'machine-1',
    });
    const requests: unknown[] = [];
    vi.spyOn(control, 'requestDaemonSignedRootActionExecution').mockImplementation(async request => {
      requests.push(request);
      return { ok: true, result: { anchor: 'appearance.themeMode', value: 'dark' } };
    });
    const owner = createCliActionExecutorFromCredentials({
      credentials, readCredentials: async () => {
        if (waitForScopeCheck) {
          scopeCheckStarted();
          await new Promise<void>(resolve => { releaseScopeCheck = resolve; });
        }
        return credentials;
      },
      serverId: 'home-1', serverApiUrl: 'https://home.example.test', serverIdentityId: 'srv_home',
      externalActionClient: true,
      actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
    });
    const controller = new AbortController();
    const prepared = await owner.prepare('settings.get', { anchor: 'appearance.themeMode' }, { surface: 'cli', signal: controller.signal });
    if (prepared.kind !== 'ready') throw new Error('Device setting read did not prepare');
    waitForScopeCheck = true;
    const running = prepared.invocation.run();
    expect(await Promise.race([
      started.then(() => 'scope_check'),
      running.then(() => 'settled_without_scope_check'),
    ])).toBe('scope_check');
    controller.abort();
    releaseScopeCheck();
    expect(await running).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(requests).toEqual([]);
  });
  it.each(['terminal', 'account'] as const)('lists declarations locally for a stored %s credential even with an own daemon', async kind => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1', provenance: {
      v: 1, kind, authority: kind === 'terminal' ? 'account_automation' : 'present_user',
    } })).toString('base64url')}.signature`;
    vi.spyOn(publication, 'resolveLiveDaemonControlTargetForServer').mockResolvedValue({
      pid: 123, httpPort: 4321, accountId: 'account-1', machineId: 'machine-1',
    });
    const requests: unknown[] = [];
    vi.spyOn(control, 'requestDaemonSignedRootActionExecution').mockImplementation(async request => {
      requests.push(request);
      return { ok: false, errorCode: 'daemon_unavailable', error: 'daemon_unavailable' };
    });
    const owner = createCliActionExecutorFromCredentials({
      credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
      serverId: 'home-1', serverApiUrl: 'https://home.example.test', serverIdentityId: 'srv_home',
      externalActionClient: true,
      actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
    });
    expect(await owner.execute('settings.list', {}, { surface: 'cli' })).toMatchObject({
      ok: true, result: { items: expect.arrayContaining([expect.objectContaining({ anchor: 'appearance.themeMode' })]) },
    });
    expect(requests).toEqual([]);
  });
  it('uses the own daemon client route without a machine flag and preserves an explicit automation ceiling', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1', provenance: {
      v: 1, kind: 'terminal', authority: 'account_automation',
    } })).toString('base64url')}.signature`;
    // These adapters cross the OS publication / daemon loopback HTTP boundary.
    // The actual CLI origination, credential classification and route selection stay real.
    const controlTarget = vi.spyOn(publication, 'resolveLiveDaemonControlTargetForServer').mockResolvedValue({
      pid: 123, httpPort: 4321, accountId: 'account-1', machineId: 'machine-1',
    });
    vi.spyOn(publication, 'resolveLiveDaemonExternalActionEndpoint').mockResolvedValue(null);
    const answered: ActionExecuteResult = { ok: true, result: {
      anchor: 'appearance.themeMode', value: 'dark',
    } };
    vi.spyOn(control, 'requestDaemonSignedRootActionExecution').mockImplementation(async (_request, options) =>
      options?.authorityCeiling === 'account_automation'
        ? { ok: false, errorCode: 'consent_required', error: 'consent_required' }
        : answered);
    const owner = createCliActionExecutorFromCredentials({
      credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
      serverId: 'home-1', serverApiUrl: 'https://home.example.test', serverIdentityId: 'srv_home',
      externalActionClient: true,
      actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
    });
    const input = { anchor: 'appearance.themeMode' };
    expect(await owner.execute('settings.get', input, { surface: 'cli' })).toEqual(answered);
    expect(await owner.execute('settings.get', input, { surface: 'cli',
      externalActionTarget: { kind: 'machine', machineId: 'machine-1' } })).toEqual(answered);
    expect(await owner.execute('settings.get', input, { surface: 'cli', authority: 'account_automation' }))
      .toMatchObject({ ok: false, errorCode: 'consent_required' });
    controlTarget.mockResolvedValue({ pid: 123, httpPort: 4321, accountId: 'different-account', machineId: 'machine-1' });
    expect(await owner.execute('settings.get', input, { surface: 'cli' }))
      .toMatchObject({ ok: false, details: { reason: 'client_unavailable' } });
  });
});
