import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { DaemonAgentInstallStartResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import type { RpcHandler, RpcHandlerContext } from '../rpc/types';
import { createAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import { registerMachineAgentInstallJobRpcHandlers } from './rpcHandlers.agentInstallJobs';
import * as persistence from '@/persistence';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it('preserves the reviewed version precondition through the real registered START handler', async () => {
  const handlers = new Map<string, RpcHandler>();
  const definition = AcpBackendDefinitionV1Schema.parse({ id: 'reviewed-agent', name: 'reviewed-agent', title: 'Reviewed Agent',
    launch: { kind: 'npm', package: '@fixture/reviewed-agent', version: '2.0.0' }, createdAt: 1, updatedAt: 2 });
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.fixture`, encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/acp') return { status: 200, data: { status: 'present', revision: 2,
      content: { t: 'plain', v: { v: 1, definitions: [definition] } } } };
    throw new Error(`Unexpected Account read: ${path}`);
  });
  const owner = createAgentInstallJobOwner({ accountId: 'alice', readTrackedSessions: () => [],
    readRegistry: () => ({ agents: [{ id: 'custom-acp', pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId,
      identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 }] }),
    readAcpCatalog: () => ({ status: 'ready', record: { v: 1, definitions: [definition] }, revision: 2 }) });
  registerMachineAgentInstallJobRpcHandlers({ owner,
    rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
  const context: RpcHandlerContext = { signal: new AbortController().signal, verifyMachineAdmissionCurrent: async () => true,
    machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: 'machine', installationId: 'installation',
      role: 'manage', encryptionMode: 'plain' } };
  try {
    const response = await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_START)!({ agentId: 'custom-acp',
      definitionId: definition.id, expectedDefinitionVersion: '1.0.0', intent: 'install', consent: { vendorRecipe: false } }, context);
    expect(DaemonAgentInstallStartResponseSchema.parse(response)).toMatchObject({ ok: false, errorCode: 'definition_version_changed' });
    expect(owner.list('alice')).toEqual({ ok: true, jobs: [] });
  } finally { await owner.shutdown(); }
});

it('refuses a requester Account definition before resolving the custodian catalog and leaves built-in target admission available', async () => {
  const handlers = new Map<string, RpcHandler>();
  const definition = AcpBackendDefinitionV1Schema.parse({ id: 'private-agent', name: 'private-agent', title: 'Private Agent',
    launch: { kind: 'command', command: 'private-command' }, createdAt: 1, updatedAt: 1 });
  const owner = createAgentInstallJobOwner({ accountId: 'custodian', readTrackedSessions: () => [],
    readRegistry: () => ({ agents: [{ id: 'custom-acp', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
      pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId }, { id: 'fixture', runtimeSpec: {
        id: 'fixture', title: 'Fixture', binaryName: 'fixture', sourcePreferenceDefault: 'system-first',
        managedInstall: null, manualInstallKind: 'none', manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false,
      } }] }),
    readAcpCatalog: () => ({ status: 'ready', record: { v: 1, definitions: [definition] }, revision: 1 }) });
  registerMachineAgentInstallJobRpcHandlers({ owner, rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
  const requester: RpcHandlerContext = { signal: new AbortController().signal, machineAdmission: {
    actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: 'machine', installationId: 'installation',
    role: 'manage', encryptionMode: 'plain',
  } };
  try {
    const handler = handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_START)!;
    for (const intent of ['install', 'update', 'uninstall'] as const) {
      expect(await handler({ agentId: 'custom-acp', definitionId: definition.id, intent, consent: { vendorRecipe: false } }, requester))
        .toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    }
    expect(owner.list()).toEqual({ ok: true, jobs: [] });
    const builtin = DaemonAgentInstallStartResponseSchema.parse(await handler({ agentId: 'fixture', intent: 'install', consent: { vendorRecipe: false } }, requester));
    expect(builtin).toMatchObject({ ok: true });
    const privateJob = owner.start({ agentId: 'custom-acp', definitionId: definition.id, intent: 'install', consent: { vendorRecipe: false } });
    expect(privateJob.ok).toBe(true); if (!privateJob.ok) return;
    await vi.waitFor(() => expect(owner.read({ jobId: privateJob.jobId, cursor: 0 })).toMatchObject({ done: true }));
    const before = owner.read({ jobId: privateJob.jobId, cursor: 0 });
    expect(before).toMatchObject({ steps: [expect.objectContaining({ label: definition.title })] });
    expect(await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST)!({}, requester)).toMatchObject({ ok: true,
      jobs: [expect.objectContaining({ agentId: 'fixture' })] });
    for (const method of [RPC_METHODS.DAEMON_AGENTS_INSTALL_READ, RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL]) {
      expect(await handlers.get(method)!({ jobId: privateJob.jobId, ...(method === RPC_METHODS.DAEMON_AGENTS_INSTALL_READ ? { cursor: 0 } : {}) }, requester))
        .toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    }
    expect(owner.read({ jobId: privateJob.jobId, cursor: 0 })).toEqual(before);
    const custodian: RpcHandlerContext = { ...requester, machineAdmission: { ...requester.machineAdmission!, actorAccountId: 'custodian' },
      verifyMachineAdmissionCurrent: async () => true };
    expect(await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_READ)!({ jobId: privateJob.jobId, cursor: 0 }, custodian)).toEqual(before);
    expect(await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL)!({ jobId: privateJob.jobId }, custodian)).toEqual({ ok: true });
    if (builtin.ok) expect(await handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_READ)!({ jobId: builtin.jobId, cursor: 0 }, requester)).toMatchObject({ ok: true });
  } finally { await owner.shutdown(); }
});
