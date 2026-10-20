import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { SESSION_PERMISSION_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import { SessionPermissionRemoteGrantRecordV1Schema } from '@happier-dev/protocol/sessions/permissions/mediationRecordsV1';
import { BasePermissionHandler } from '@/agent/permissions/BasePermissionHandler';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { PermissionMediationRecordStore, PermissionMediationStoredRecord } from '@/agent/permissions/mediation/permissionMediationRecordStore';
import { createMutableApiSessionClientFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { registerCurrentSessionUiBinding } from '@/session/presentation/currentSessionUiBindings';
import { createCliActionExecutor } from './createCliActionExecutor';

const network = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: network.io }));
afterEach(() => { vi.restoreAllMocks(); network.io.mockReset(); });

class GrantPermissionHandler extends BasePermissionHandler {
  protected getLogPrefix() { return '[Grant Action composition]'; }
  // The grant-only fixture does not admit new tool requests.
  handleToolCall: ProviderEnforcedPermissionHandler['handleToolCall'] = async () => { throw new Error('Unexpected tool request'); };
}

describe('CLI remote grant Actions at the real current-Session permission owner', () => {
  it.each([
    { surface: 'agent', placement: 'local' },
    { surface: 'mcp', placement: 'local' },
    { surface: 'agent', placement: 'remote' },
  ] as const)('lists and durably revokes a grant for an Account Session caller on $surface ($placement)', async ({ surface, placement }) => {
    const sessionId = 'c123456789012345678901234';
    const identity = { sessionId, turnId: 'turn', requestId: 'request' };
    const record = SessionPermissionRemoteGrantRecordV1Schema.parse({ version: 1, turnId: identity.turnId, requestId: identity.requestId,
      settlementId: 'settlement', mediatorPluginId: 'acme.mediator', idempotencyKey: 'grant-retry',
      sourceAuthority: { kind: 'mediatedExternal', mediatorPluginId: 'acme.mediator', sourceRef: 'binding:one', sourceRevisionOrEpoch: '1',
        admittedPermissionCeiling: 'default', remoteApprovalMaxScope: 'session' },
      actor: { kind: 'externalHuman', assurance: 'pluginAsserted', namespace: 'external', principalId: 'person',
        assertedBy: { pluginId: 'acme.mediator', contributionLocalId: 'channel' } },
      decision: 'allow', requestedScope: 'session', effect: { kind: 'sessionGrant', grantId: 'grant', rule: { kind: 'exactTool', identifier: 'Bash' } },
      createdAtMs: 1 });
    let stored: PermissionMediationStoredRecord = { identity, kind: 'remote_grant.v1', record, revision: 'ssr1.AAAACHNldHRsZW1lbnQtMwAAAAE' };
    // Only the persistent ledger is replaced. Hydration, visibility, caller
    // projection, revocation actor and the real CAS decision remain in-process.
    const ledger: PermissionMediationRecordStore = {
      read: async () => ({ status: 'found', stored }),
      list: async () => ({ status: 'ready', records: [stored], nextCursor: null, hasNext: false }),
      createExpectedAbsent: async () => ({ status: 'conflict' }),
      pruneInactive: async () => ({ status: 'unavailable' }),
      compareAndSet: async input => {
        if (input.expectedRevision !== stored.revision) return { status: 'conflict' };
        stored = { ...input, revision: 'ssr1.AAAACHNldHRsZW1lbnQtMwAAAAI' };
        return { status: 'updated', stored };
      },
    };
    const session = createMutableApiSessionClientFixture({ sessionId, agentState: { requests: {}, completedRequests: {} },
      overrides: { getAuthenticatedAccountId: async () => 'account-owner' } });
    const permissionHandler = new GrantPermissionHandler(session, { mediationRecordStore: ledger });
    const lifetime = new AbortController();
    const bindOwner = () => registerCurrentSessionUiBinding({ sessionId, signal: lifetime.signal, isCurrent: () => true,
      service: { interactions: { request: async () => { throw new Error('Unexpected transient interaction'); } } },
      capabilities: { permissionHandler, readPermissionMode: () => 'default' } });
    const dispose = placement === 'local' ? bindOwner() : () => {};
    const ownerExecutor = createCliActionExecutor({ token: 'runtime-token', sessionId, mode: 'plain', ctx: null,
      pluginActionExecutionOwner: 'current_process',
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) } });
    const receiver = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
    registerActionSpecRpcHandlers({ rpcHandlerManager: receiver, actionExecutor: ownerExecutor, scopes: SESSION_PERMISSION_RPC_SCOPES });
    const answer = async (event: string, payload: unknown) => {
      if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object') throw new Error('Unexpected grant transport');
      const method = Reflect.get(payload, 'method');
      if (typeof method !== 'string') throw new Error('Missing grant RPC method');
      // The source process has no live binding. Only the receiving process
      // owns this capability; install its fixture around the real receiver.
      const release = bindOwner();
      try { return { ok: true, result: await receiver.handleRequest({ method, params: Reflect.get(payload, 'params'),
        callerAuthority: 'account_automation' }) }; } finally { release(); }
    };
    network.io.mockImplementation((_url, options) => {
      expect(options?.auth).toMatchObject({ authorityCeiling: 'account_automation' });
      return createApiSessionSocketStub({ emitWithAck: answer, emit: (event, [payload, callback]) => {
        if (typeof callback === 'function') void answer(event, payload).then(value => callback(value));
      } });
    });
    const credentials = { token: 'account-token', encryption: null };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId,
        share: null, active: true, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'grant-machine' }) }) } };
      throw new Error(`Unexpected grant HTTP ${url}`);
    });
    const executor = placement === 'local' ? ownerExecutor : createCliActionExecutor({ token: credentials.token, credentials,
      sessionId: 'daemon', mode: 'plain', ctx: null, pluginActionExecutionOwner: 'current_process',
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) } });
    const context = { surface, authority: 'account_automation' as const, defaultSessionId: sessionId,
      actionCaller: { kind: 'session' as const, sessionId } };
    try {
      const listed = await executor.execute('session.permission.remote.grants.list', { sessionId }, context);
      expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true, result: { grants: [{ grantId: 'grant', projection: { kind: 'owner',
        rule: { kind: 'exactTool', identifier: 'Bash' } } }], nextCursor: null } });
      // The plugin neighbour retains its own-source visibility.
      if (placement === 'local') expect(await executor.execute('session.permission.remote.grants.list', { sessionId }, { ...context,
        surface: 'plugin', actionCaller: { kind: 'plugin', pluginId: 'acme.other' } }))
        .toEqual({ ok: true, result: { grants: [], nextCursor: null } });
      expect(await executor.execute('session.permission.remote.grants.revoke', { ...identity, grantId: 'grant' }, context))
        .toEqual({ ok: true, result: { status: 'revoked', grantId: 'grant' } });
      expect(stored.record.revoked).toMatchObject({ actor: { kind: 'accountUser', accountId: 'account-owner' } });
      expect(await executor.execute('session.permission.remote.grants.revoke', { ...identity, grantId: 'grant' }, context))
        .toEqual({ ok: true, result: { status: 'alreadyRevoked', grantId: 'grant' } });
      lifetime.abort();
      expect(await executor.execute('session.permission.remote.grants.list', { sessionId }, context))
        .toMatchObject({ ok: false, errorCode: 'ownerMachineUnavailable' });
      expect(await executor.execute('session.permission.remote.grants.revoke', { ...identity, grantId: 'grant' }, context))
        .toEqual({ ok: true, result: { status: 'rejected', code: 'ownerMachineUnavailable' } });
      const deliveries = network.io.mock.calls.length;
      expect(await executor.execute('session.permission.remote.grants.list', { sessionId }, { ...context,
        rpcSessionAuthorization: { kind: 'session.write', sessionId } }))
        .toMatchObject({ ok: false, errorCode: 'ownerMachineUnavailable' });
      expect(network.io.mock.calls).toHaveLength(deliveries);
    } finally { dispose(); lifetime.abort(); await permissionHandler.reset(); await session.close(); }
  });
});
