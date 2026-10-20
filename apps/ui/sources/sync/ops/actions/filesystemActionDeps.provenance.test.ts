import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// Socket.IO and Home HTTP are the process boundaries. A raw request reproduces
// the receiving daemon's RPC confirmation floor instead of borrowing UI origin.
installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    socket.emitWithAck = vi.fn(async (event: string, payload: SocketRpcRequestPayload) => {
        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
        const request = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
        return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, {
            kind: 'approval_request_created', artifactId: 'raw-rpc-approval', actionId: 'daemon.filesystem.writeFile',
        }, request.callId) };
    });
});
const { socketRpcCodec } = await import('@happier-dev/sync-client');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { createUiFilesystemAction } = await import('./filesystemActionDeps');
const { callAdmittedFilesystemTransferActionRpc } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/filesystemTransferActionClient');
let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
let serverId: string;
let misbound = false;
const installation = tweetnacl.sign.keyPair();
const hash = 'a'.repeat(64);

beforeEach(async () => {
    await homes.reset();
    misbound = false;
    serverId = await homes.addHome({ name: 'Filesystem origin', serverUrl: 'https://filesystem-origin.test',
        serverIdentityId: 'srv_filesystem_origin', accountId: 'owner', currentAccount: true, active: false });
    const machine = { ...createPlainMachineRowFixture({ id: 'machine', accountId: 'owner' }), installationId: 'installation',
        installationPublicKey: encodeBase64(installation.publicKey, 'base64'),
        access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    homes.answer(serverId, 'GET /v1/machines/machine', { body: { machine } });
    for (const actionId of ['daemon.filesystem.writeFile', 'daemon.filesystem.download'] as const) {
        homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-root', binding: {
                accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_filesystem_origin',
                machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner',
                accountEncryptionMode: 'plain', actionId, requestId: request.envelope.requestId, target: request.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            } }) };
        } });
        homes.answer(serverId, `/v1/actions/${actionId}`, { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            if (!request.executionAuthorization) throw new Error('Missing authenticated invocation');
            const opened = openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                installationPrivateKey: installation.secretKey, machineId: 'machine', installationId: 'installation',
                serverIdentityId: 'srv_filesystem_origin', purpose: { kind: 'external_action' }, includeInvocation: true });
            expect(opened?.invocation).toMatchObject({ surface: 'ui', authority: 'present_user', caller: { kind: 'host' } });
            expect(request.envelope.target).toEqual({ kind: 'machine', machineId: 'machine' });
            expect(isApprovalRequiredByActionsSettings(actionId, { v: 1, actions: {} }, opened?.invocation)).toBe(false);
            return { body: { v: 1, actionId: misbound ? 'daemon.filesystem.rename' : actionId,
                requestId: request.envelope.requestId, execution: { ok: true,
                    result: actionId === 'daemon.filesystem.writeFile' ? { success: true, hash }
                        : { success: false, errorCode: 'source_missing', error: 'Fixture source is absent' } } } };
        } });
    }
    account = await captureLazyActionAccountContext(serverId);
});
afterEach(async () => { account?.dispose(); account = null; await homes.reset(); });

function context(): ActionExecutorContext {
    return { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId, runtimeAccountId: 'owner', actionRequestId: 'filesystem-origin',
        externalActionTarget: { kind: 'machine', machineId: 'machine' } };
}
async function save() {
    if (!account) throw new Error('Missing captured Account');
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction(account) }));
    return await executor.execute('daemon.filesystem.writeFile', {
        rootPath: '/repo', path: '/repo/file', content: 'bWluZQ==', expectedHash: null,
    }, context());
}

describe('filesystem Action invocation provenance across the Machine boundary', () => {
    it('retains the present UI requester through authenticated write delivery', async () => {
        expect(await save()).toEqual({ ok: true, result: { success: true, hash } });
        expect(homes.requestsFor('/v1/actions/daemon.filesystem.writeFile')).toHaveLength(1);
    });
    it('retains that origin when a mounted preview driver prepares a download', async () => {
        expect(await callAdmittedFilesystemTransferActionRpc({ actionId: 'daemon.filesystem.download',
            serverId, machineId: 'machine', accountId: 'owner', context: context(),
            input: { rootPath: '/repo', path: '/repo/image.png', destination: { destinationId: 'preview' }, asZip: false },
        })).toEqual({ success: false, errorCode: 'source_missing', error: 'Fixture source is absent' });
        expect(homes.requestsFor('/v1/actions/daemon.filesystem.download')).toHaveLength(1);
    });
    it('refuses a misbound Action reply instead of reporting a completed save', async () => {
        misbound = true;
        expect(await save()).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    });
});
