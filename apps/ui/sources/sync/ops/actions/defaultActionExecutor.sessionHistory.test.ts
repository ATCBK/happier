import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { getStorage } = await import('@/sync/domains/state/storage');
const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
const initialState = getStorage().getState();

describe('Session history through the UI Action front door', () => {
    beforeEach(async () => { await homes.reset(); });
    afterEach(() => { getStorage().setState(initialState, true); standardCleanup(); });

    it.each([
        { format: 'compact', custody: 'current' },
        { format: 'raw', custody: 'current' },
        { format: 'raw', custody: 'retired' },
        { format: 'raw', custody: 'cancelled' },
    ] as const)('discloses $format history only for current Account custody ($custody)', async ({ format, custody }) => {
        const homeId = 'srv_history_requester';
        const serverUrl = 'https://history-requester.test';
        const serverId = await homes.addHome({ name: 'History Home', serverUrl, serverIdentityId: homeId,
            accountId: 'alice', currentAccount: true });
        const token = homes.findByServerUrl(serverUrl)?.token;
        if (!token) throw new Error('Missing original Account credential');
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'session.history.get': ['ui'] } },
        } }, version: 1 } });
        const machineId = 'history-reader';
        const installationId = 'history-installation';
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
        const machine = createMachineFixture({ id: machineId, activeAt: Date.now() });
        getStorage().setState({ machines: { [machineId]: machine }, machineListByServerId: { [serverId]: [machine] },
            machineListStatusByServerId: { [serverId]: 'idle' } });
        // The Action Machine is read by id through the Machine rows reader (a532f4a1e0).
        homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine: { ...createPlainMachineRowFixture({ id: machineId, accountId: 'alice' }),
            installationId, installationPublicKey: encodeBase64(installation.publicKey) } } });
        const input = { sessionId: 'diagnostic-session', limit: 25, format, includeMeta: true, includeStructuredPayload: true };
        const invocation = { caller: { kind: 'host' as const }, surface: 'ui' as const, authority: 'present_user' as const,
            callerPermissionMode: 'read-only' as const, callerInputConstraints: { models: null, permissionModes: ['read-only' as const] },
            workspaceWrites: 'deny' as const, defaultSessionId: 'invoking-session' };
        const requestId = `history-${format}`;
        const controller = new AbortController();
        homes.answer(serverId, '/v1/actions/session.history.get/execution-authorization', { select: (body, request) => {
            expect(request.signal?.aborted).toBe(false);
            const mint = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(mint.envelope).toMatchObject({ requestId, target: { kind: 'machine', machineId }, input });
            return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'history-home-root', binding: {
                accountId: 'alice', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: homeId,
                machineId, installationId, custodianAccountId: 'alice', accountEncryptionMode: 'plain',
                actionId: 'session.history.get', requestId, target: mint.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(mint.envelope),
            } }) };
        } });
        // HTTP is the genuine process boundary. The private relay, invocation
        // codec, Account capture, input admission and output consumer remain real.
        const diagnosticHistory = { sessionId: input.sessionId, items: [{ kind: 'tool_call', payload: { diagnostic: true } }] };
        homes.answer(serverId, '/v1/actions/session.history.get', { select: async (body, request) => {
            const carried = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(openExternalActionRequesterAccountContextV1({ authorization: carried.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId, installationId, serverIdentityId: homeId,
                installationPrivateKey: installation.secretKey, includeInvocation: true })).toEqual({ credentials: { token }, invocation });
            expect(JSON.stringify(carried)).not.toContain(token);
            if (custody === 'retired') await homes.switchAccount(serverId, 'replacement');
            if (custody === 'cancelled') {
                controller.abort();
                expect(request.signal?.aborted).toBe(true);
            }
            return { body: { v: 1, actionId: 'session.history.get', requestId, execution: { ok: true, result: diagnosticHistory } } };
        } });
        const result = await createFrontDoorActionExecute()('session.history.get', input, {
            serverId, expectedAccountId: 'alice', actionRequestId: requestId, signal: controller.signal,
            surface: invocation.surface, authority: invocation.authority, actionCaller: invocation.caller,
            callerPermissionMode: invocation.callerPermissionMode, callerInputConstraints: invocation.callerInputConstraints,
            workspaceWrites: invocation.workspaceWrites, defaultSessionId: invocation.defaultSessionId,
        }).catch(error => {
            expect(custody).toBe('cancelled');
            expect(error).toMatchObject({ name: 'AbortError' });
            return { ok: false as const };
        });
        if (custody === 'current') expect(result).toEqual({ ok: true, result: diagnosticHistory });
        else {
            expect(result).toMatchObject({ ok: false });
            expect(result).not.toHaveProperty('result');
        }
        expect(homes.requests.filter(request => request.path.startsWith('/v1/actions/')).map(request => request.path))
            .toEqual(['/v1/actions/session.history.get/execution-authorization', '/v1/actions/session.history.get']);
    });

    it('retains the events UI surface refusal rather than promoting the deprecated alias into new authority', async () => {
        const serverId = await homes.addHome({ name: 'History Home', serverUrl: 'https://history-surface.test',
            accountId: 'alice', currentAccount: true });
        expect(await createFrontDoorActionExecute()('session.events.get', { sessionId: 'diagnostic-session' }, { surface: 'ui', serverId }))
            .toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(homes.requests.filter(request => request.path.startsWith('/v1/actions/'))).toEqual([]);
    });
});
