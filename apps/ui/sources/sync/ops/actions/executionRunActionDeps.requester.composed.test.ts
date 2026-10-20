import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const machineMethods: string[] = [];
// Only the external Socket.IO SDK transport is synthetic. Scoped Account,
// Machine setup/reachability, RPC envelopes and response correlation stay real.
installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    socket.emitWithAck = vi.fn(async (event: string, payload: unknown) => {
        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
        if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string'
            || !('params' in payload)) throw new Error('Missing Machine RPC wire request');
        machineMethods.push(payload.method);
        expect(payload.method).toBe('machine:capabilities.detect');
        const request = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
        expect(request.params).toEqual({ requests: [{ id: 'tool.executionRuns' }] });
        return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, {
            protocolVersion: 1, results: { 'tool.executionRuns': { ok: true, checkedAt: 1,
                data: { protocolVersion: 2, features: { detachedScope: true, startAndWait: true, runScopedAgentBindings: true } } } },
        }, request.callId) };
    });
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { socketRpcCodec } = await import('@happier-dev/sync-client');
const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { createUiExecutionRunActionDeps } = await import('./executionRunActionDeps');

beforeEach(async () => { await homes.reset(); machineMethods.length = 0; });
afterEach(() => standardCleanup());

it.each(['accepted', 'refused', 'foreign-root', 'uncertain'] as const)('FIX81 carries direct detached start through original requester Action admission: %s', async scenario => {
    const homeId = 'srv_detached_requester';
    const serverId = await homes.addHome({ name: 'Detached requester', serverUrl: 'https://detached-requester.test',
        serverIdentityId: homeId, accountId: 'requester', currentAccount: true });
    const machineId = 'machine';
    const onTransportIssued = vi.fn();
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
    const machine = { id: machineId, kind: 'persistent', active: true,
        installationId: 'installation', installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null, replacedByMachineId: null,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, runnerContentKeyBinding: null,
        access: { custodian: { accountId: 'requester', displayName: 'Requester' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine } });
    homes.answer(serverId, '/v1/actions/execution.run.start', { select: body => {
        if (scenario === 'uncertain') return { status: 502 };
        const envelope = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
        const request = envelope.success ? envelope.data.envelope : body;
        if (!request || typeof request !== 'object' || !('input' in request) || !('requestId' in request)) throw new Error('Missing original Action envelope');
        expect(getActionSpec('execution.run.start').inputSchema.parse(request.input)).toMatchObject({ sessionId: null, cwd: '/repo' });
        expect(request).toMatchObject({ target: { kind: 'machine', machineId } });
        if (!envelope.success) throw new Error('The direct start must use the admitted requester carrier');
        expect(openExternalActionRequesterAccountContextV1({ authorization: envelope.data.executionAuthorization,
            purpose: { kind: 'external_action' }, machineId, installationId: 'installation', serverIdentityId: homeId,
            installationPrivateKey: installation.secretKey, includeInvocation: true })).toMatchObject({
                invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
            });
        return { body: { v: 1, actionId: 'execution.run.start', requestId: request.requestId,
            execution: scenario === 'accepted' ? { ok: true, result: { runId: 'detached-run', callId: 'call', sidechainId: 'sidechain' } }
                : { ok: false, errorCode: 'project_requester_credentials_unavailable', error: 'Retired requester',
                    details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } } } };
    } });
    homes.answer(serverId, '/v1/actions/execution.run.start/execution-authorization', { select: body => {
        const mint = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
            accountId: scenario === 'foreign-root' ? 'another-account' : 'requester', custodianAccountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 },
            accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId, installationId: 'installation',
            actionId: 'execution.run.start', requestId: mint.envelope.requestId, target: mint.envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(mint.envelope),
        } }) };
    } });
    const result = await createFrontDoorActionExecute(createDefaultActionExecutor())('execution.run.start', {
        sessionId: null, intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'kilo' },
        cwd: '/repo', instructions: 'Inspect the Project.', permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
        connectedServices: { v: 2, bindingsByServiceId: {} },
    }, { surface: 'ui', serverId, expectedAccountId: 'requester', executionRunTargetMachineId: machineId, onTransportIssued });
    expect(homes.requestsFor('/v1/actions/execution.run.start'), JSON.stringify(result)).toHaveLength(scenario === 'foreign-root' ? 0 : 1);
    if (scenario === 'accepted') expect(result).toMatchObject({ ok: true, result: { runId: 'detached-run' } });
    else if (scenario === 'foreign-root') expect(result).toMatchObject({ ok: false, errorCode: 'admission_unavailable',
        details: { executionRunStart: { runCreation: 'noRunCreated' } } });
    else if (scenario === 'uncertain') expect(result).toMatchObject({ ok: false, errorCode: 'outcome_uncertain',
        details: { executionRunStart: { runCreation: 'outcomeUnknown' } } });
    else expect(result).toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable',
        details: { executionRunStart: { runCreation: 'noRunCreated' } } });
    expect(machineMethods).toEqual(['machine:capabilities.detect']);
    expect(onTransportIssued).toHaveBeenCalledTimes(scenario === 'foreign-root' ? 0 : 1);
});

it('refuses non-JSON detached input before issuing an Action and reports no Run created', async () => {
    const serverId = await homes.addHome({ name: 'Invalid detached input', serverUrl: 'https://invalid-detached.test',
        serverIdentityId: 'srv_invalid_detached', accountId: 'requester', currentAccount: true });
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
    const machine = { id: 'machine', kind: 'persistent', active: true, installationId: 'installation',
        installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null, replacedByMachineId: null,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, runnerContentKeyBinding: null,
        access: { custodian: { accountId: 'requester', displayName: 'Requester' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    homes.answer(serverId, '/v1/machines/machine', { body: { machine } });
    const account = await captureLazyActionAccountContext(serverId);
    const onTransportIssued = vi.fn();
    try {
        const result = await createUiExecutionRunActionDeps(account.accountLifetime.scope, account).executionRunStart(null, {
            intent: 'agent', instructions: 'Inspect.', connectedServices: new Map(),
        }, { serverId: account.serverId, runtimeAccountId: account.accountId, exactMachineId: 'machine',
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, onTransportIssued });
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters',
            details: { executionRunStart: { runCreation: 'noRunCreated' } } });
        expect(homes.requestsFor('/v1/actions/execution.run.start')).toEqual([]);
        expect(homes.requestsFor('/v1/actions/execution.run.start/execution-authorization')).toEqual([]);
        expect(onTransportIssued).not.toHaveBeenCalled();
    } finally { account.dispose(); }
});

it.each(['mismatched', 'retired'] as const)('FIX81 refuses %s requester custody before detached dispatch', async scenario => {
    const serverId = await homes.addHome({ name: 'Retained requester', serverUrl: 'https://retained-requester.test',
        serverIdentityId: 'srv_retained_requester', accountId: 'requester', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    try {
        if (scenario === 'retired') await homes.switchAccount(serverId, 'replacement');
        const result = await createUiExecutionRunActionDeps(account.accountLifetime.scope, account).executionRunStart(null, {
            intent: 'agent', instructions: 'Inspect the Project.',
        }, { serverId: account.serverId, runtimeAccountId: scenario === 'mismatched' ? 'another-account' : account.accountId,
            exactMachineId: 'machine', surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: false, errorCode: 'content_unavailable',
            details: { executionRunStart: { runCreation: 'noRunCreated' } } });
        expect(homes.requestsFor('/v1/actions/execution.run.start')).toHaveLength(0);
        expect(machineMethods).toEqual([]);
    } finally { account.dispose(); }
});
