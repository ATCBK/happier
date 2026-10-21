import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '@/api/encryption';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RpcHandlerManager } from './RpcHandlerManager';
import { logger as fileLogger } from '@/ui/logger';
import { createActionExecutor } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import type { Socket } from 'socket.io-client';

describe('RPC completion diagnostics', () => {
    it.each([
        { phase: 'host_publication_rejected' },
        { phase: 'never-log-native-detail' },
        { phase: 'native_effect', error: 'never-log-objective' },
    ])('records only a closed Goal settlement phase %j once', async goalControlFailure => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger });
        rpc.registerHandler('session.goal.set', () => ({ ok: false,
            errorCode: 'session_goal_control_work_state_unavailable', goalControlFailure }));
        await rpc.invokeLocal('session.goal.set', { objective: 'never-log-objective' });
        expect(logger.mock.calls).toHaveLength(1);
        const completed = logger.mock.calls[0]?.[1];
        if (goalControlFailure.phase === 'host_publication_rejected') {
            expect(completed).toMatchObject({ goalControlFailure: { phase: 'host_publication_rejected' } });
        } else expect(completed).not.toHaveProperty('goalControlFailure');
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });
    it.each(['deadline', 'cancel', 'disconnect'] as const)('settles held Home admission on its existing %s while unrelated RPCs complete', async lifetime => {
        const logger = vi.fn();
        const key = tweetnacl.sign.keyPair();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let entered = false;
        // A transport can finish after cancellation; internal admission remains real.
        const network = vi.spyOn(axios, 'post').mockImplementation(async () => {
            entered = true;
            await held;
            return { status: 200, data: { v: 1, ok: true } };
        });
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger,
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'machine', resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
                verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
                    privateKey: key.secretKey, daemonToken: 'test-token', serverHttpBaseUrl: 'https://home.invalid' }),
            }) });
        let dispatched = false;
        rpc.registerHandler('demo', () => { dispatched = true; });
        rpc.registerHandler('health', () => ({ ok: true }));
        const socket = createApiSessionSocketStub({ connected: true });
        // Canonical Socket.IO boundary stub exposes the manager's consumed subset.
        rpc.onSocketConnect(socket as unknown as Socket);
        let result: unknown;
        const request = rpc.handleRequest({ method: 'machine:demo', params: {}, requestId: 'held-admission',
            ...(lifetime === 'deadline' ? { timeoutMs: 100 } : {}),
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                installationId: 'installation', role: 'manage', encryptionMode: 'plain' } })
            .then(value => { result = value; });
        try {
            await vi.waitFor(() => expect(entered).toBe(true));
            expect(await rpc.handleRequest({ method: 'machine:health', params: {} })).toEqual({ ok: true });
            if (lifetime === 'cancel') socket.trigger('rpc-cancel', { requestId: 'held-admission' });
            if (lifetime === 'disconnect') rpc.onSocketDisconnect();
            await vi.waitFor(() => expect(result).toBeDefined());
            expect(result).toEqual({ error: lifetime === 'deadline' ? 'RPC request timed out'
                : lifetime === 'cancel' ? 'RPC request cancelled by caller' : 'RPC target transport disconnected',
                ...(lifetime === 'deadline' ? { errorCode: 'MACHINE_RPC_TIMEOUT' } : {}) });
            expect(dispatched).toBe(false);
            expect(logger).toHaveBeenLastCalledWith('[RPC] Request completed', expect.objectContaining({
                ...(lifetime === 'deadline' ? { outcomeCode: 'RPC_REQUEST_TIMEOUT' } : {}),
                failedPhase: 'authorize_request', cancelled: true,
                phaseDurationsMs: expect.objectContaining({ authorize_request: expect.any(Number) }),
            }));
            expect(rpc.getInFlightRequestCount()).toBe(0);
        } finally { release(); await request; network.mockRestore(); }
        expect(dispatched).toBe(false);
    });
    it('answers a failed Home verification with its typed refusal and admission phase', async () => {
        const logger = vi.fn();
        const key = tweetnacl.sign.keyPair();
        const network = vi.spyOn(axios, 'post').mockResolvedValue({ status: 503, data: {} });
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger,
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'machine', resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
                verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
                    privateKey: key.secretKey, daemonToken: 'test-token', serverHttpBaseUrl: 'https://home.invalid' }),
            }) });
        let dispatched = false;
        rpc.registerHandler('demo', () => { dispatched = true; });
        try {
            expect(await rpc.handleRequest({ method: 'machine:demo', params: {},
                machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                    installationId: 'installation', role: 'manage', encryptionMode: 'plain' } }))
                .toEqual({ error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN });
            expect(dispatched).toBe(false);
            expect(logger).toHaveBeenLastCalledWith('[RPC] Request completed', expect.objectContaining({
                outcomeCode: RPC_ERROR_CODES.FORBIDDEN, admissionPredicate: 'machine_currentness',
                failedPhase: 'authorize_request', cancelled: false,
                phaseDurationsMs: expect.objectContaining({ authorize_request: expect.any(Number) }),
            }));
        } finally { network.mockRestore(); }
    });
    it.each(['ECONNABORTED', 'private_token'])('bounds wrapped failure diagnostics for %s', async code => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        rpc.registerHandler('demo', () => {
            throw new Error('never-log-error', { cause: Object.assign(new Error('never-log-cause'), { code }) });
        });
        expect(await rpc.handleRequest({ method: 'machine:demo', params: {} })).toEqual({ error: 'never-log-error' });
        const completed = logger.mock.calls.at(-1)?.[1];
        expect(completed).toMatchObject({ failedPhase: 'handler', cancelled: false,
            phaseDurationsMs: expect.objectContaining({ handler: expect.any(Number) }) });
        if (code === 'ECONNABORTED') expect(completed).toMatchObject({ causeCode: code });
        else expect(completed).not.toHaveProperty('causeCode');
        expect(JSON.stringify(logger.mock.calls)).not.toMatch(/never-log|private_token/);
    });
    it('records only generation schema issue paths and codes at the real Machine SCM boundary', async () => {
        const record = vi.spyOn(fileLogger, 'infoFile').mockImplementation(() => {});
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {} });
        const executor = createActionExecutor({
            ...createUnavailableActionTransportDeps(),
            scmActionExecute: async () => { throw new Error('Invalid input must not cross SCM admission'); },
        });
        registerScmHandlers(rpc, '/repo', { machineId: 'machine', actionExecutor: executor });
        try {
            const result = await rpc.handleRequest({ method: 'machine:scm.diffSummary.generate', callerAuthority: 'present_user',
                params: { cwd: '/repo', source: { kind: 'workingTree' }, outputLanguage: 'never-log-language-value',
                    modelSelector: { modelId: 42 }, 'never-log-unknown-key': 'never-log-value' } });
            expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            expect(record).toHaveBeenCalledWith('[RPC] SCM input validation failed', {
                actionId: 'scm.diffSummary.generate', issues: expect.arrayContaining([
                    { path: ['modelSelector', 'modelId'], code: 'invalid_type' },
                    { path: [], code: 'unrecognized_keys' },
                ]),
            });
            expect(JSON.stringify(record.mock.calls)).not.toContain('never-log');
        } finally { record.mockRestore(); }
    });
    it('retains the host request timeout reason through handler cancellation', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        rpc.registerHandler('demo.wait', (_input, context) => new Promise((_resolve, reject) => {
            if (!context) throw new Error('Expected actual handler cancellation context');
            context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        }));
        expect(await rpc.handleRequest({ method: 'machine:demo.wait', params: {}, timeoutMs: 1 }))
            .toEqual({ error: 'RPC request timed out', errorCode: 'MACHINE_RPC_TIMEOUT' });
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({ outcomeCode: 'RPC_REQUEST_TIMEOUT' })]]);
    });

    it('preserves the owning deadline code when a cancelled handler rejects with a boundary abort error', async () => {
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger() {} });
        rpc.registerHandler('demo.wait', (_input, context) => new Promise((_resolve, reject) => {
            if (!context) throw new Error('Expected actual handler cancellation context');
            context.signal.addEventListener('abort', () => reject(new DOMException('Boundary aborted', 'AbortError')), { once: true });
        }));
        expect(await rpc.handleRequest({ method: 'machine:demo.wait', params: {}, timeoutMs: 1 }))
            .toMatchObject({ errorCode: 'MACHINE_RPC_TIMEOUT' });
    });

    it.each(['EACCES', 'ENOENT', 'RIPGREP_ABORTED'])(
        'retains native exception code %s without changing the transported error or logging prose', async (code) => {
            const logger = vi.fn();
            const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
            rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST, () => {
                throw Object.assign(new Error('never-log-sensitive-path'), { code });
            });
            expect(await rpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST}`, params: {} }))
                .toEqual({ error: 'never-log-sensitive-path' });
            expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({ outcomeCode: code })]]);
            expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
        },
    );

    it('classifies cancellation and the workspace search failure union through actual dispatch', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST, () => {
            throw new DOMException('never-log-cancelled-search', 'AbortError');
        });
        rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH, () => ({ ok: false, code: 'ripgrep_failed' }));
        rpc.registerHandler('demo.execution', () => ({ ok: true, code: 0 }));
        await rpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST}`, params: {} });
        await rpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH}`, params: {} });
        await rpc.handleRequest({ method: 'machine:demo.execution', params: {} });
        expect(logger.mock.calls).toEqual(['request_cancelled', 'ripgrep_failed', 'ok'].map(outcomeCode =>
            ['[RPC] Request completed', expect.objectContaining({ outcomeCode })]));
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });

    it.each(['permission_request_not_found', 'permission_actor_unattributable', 'permission_response_invalid', 'future_native_refusal_v2'])(
        'retains the typed handler refusal %s for a relay-attributed Session request', async (errorCode) => {
            const logger = vi.fn();
            const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger });
            rpc.registerHandler('session.permission.respond', () => ({ ok: false, errorCode, requestId: 'never-log-request' }));
            const result = await rpc.handleRequest({ method: 'session:session.permission.respond', params: {}, authorization: {
                kind: 'session.permission.respond', sessionId: 'session',
                actor: { kind: 'accountUser', accountId: 'never-log-account', relationship: 'owner' },
            } });
            expect(result).toMatchObject({ ok: false, errorCode });
            expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({
                outcomeCode: errorCode, callerClass: 'session',
            })]]);
            expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
        },
    );

    it('preserves shape-approved thrown codes and bounds the diagnostic token', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger });
        const code = `N${'a'.repeat(127)}`;
        rpc.registerHandler('demo', () => { throw new RpcError('never-log-error', code); });
        await rpc.handleRequest({ method: 'session:demo', params: {} });
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({ outcomeCode: code })]]);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });

    it.each(['private/path', 'private token', 'private\ncode', 'private_code\n', 'private-code', 'échec', `N${'a'.repeat(128)}`, ''])(
        'does not disclose a malformed or oversized refusal code %j', async (errorCode) => {
            const logger = vi.fn();
            const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger });
            rpc.registerHandler('demo', () => ({ ok: false, errorCode }));
            rpc.registerHandler('demo.native', () => { throw Object.assign(new Error('never-log-native-detail'), { code: errorCode }); });
            await rpc.handleRequest({ method: 'session:demo', params: {} });
            await rpc.handleRequest({ method: 'session:demo.native', params: {} });
            expect(logger.mock.calls).toEqual([0, 1].map(() =>
                ['[RPC] Request completed', expect.objectContaining({ outcomeCode: 'unclassified_error' })]));
            expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
        },
    );

    it('does not attribute a malformed or differently scoped relay stamp to the Session', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger });
        rpc.registerHandler('demo', () => ({ ok: false, errorCode: 'permission_actor_unattributable' }));
        for (const authorization of [{ kind: 'session.permission.respond', sessionId: 'session' },
            { kind: 'session.write', sessionId: 'other-session' }]) {
            // Deliberately malformed/unscoped transport stamps must never acquire Session attribution.
            // @ts-expect-error Exercise invalid wire data rather than manufacturing a valid authority.
            await rpc.handleRequest({ method: 'session:demo', params: {}, authorization });
        }
        expect(logger.mock.calls).toEqual([0, 1].map(() => ['[RPC] Request completed', expect.objectContaining({
            outcomeCode: 'permission_actor_unattributable', callerClass: 'unattributed',
        })]));
    });

    it('uses the file info level so ordinary Session defaults retain completion records', async () => {
        // The file sink is the boundary; RPC admission and dispatch remain real.
        const info = vi.spyOn(fileLogger, 'infoFile').mockImplementation(() => {});
        const debug = vi.spyOn(fileLogger, 'debug').mockImplementation(() => {});
        try {
            const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain' });
            rpc.registerHandler('demo', () => ({ ok: true }));
            await rpc.handleRequest({ method: 'session:demo', params: {} });
            expect(info.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({ method: 'demo', outcomeCode: 'ok' })]]);
            expect(debug.mock.calls).toEqual([]);
        } finally { info.mockRestore(); debug.mockRestore(); }
    });
    it('correlates overlapping dispatches independently without logging input or output', async () => {
        const logger = vi.fn();
        let now = 100;
        let release: () => void = () => {};
        const pending = new Promise<void>(resolve => { release = resolve; });
        const rpc = new RpcHandlerManager({ scopePrefix: 'private-session', encryptionMode: 'plain', logger, nowMs: () => now });
        rpc.registerHandler('demo', async (input: { wait?: boolean }) => {
            if (input.wait) await pending;
            return { secretResult: 'never-log-output' };
        });
        const first = rpc.handleRequest({ method: 'private-session:demo', requestId: 'relay-a', params: { wait: true, token: 'never-log-input' } });
        now = 110;
        await rpc.handleRequest({ method: 'private-session:demo', requestId: 'relay-b', params: {} });
        now = 145;
        release();
        await first;
        expect(logger.mock.calls).toEqual(['relay-b', 'relay-a'].map((id, index) => [
            '[RPC] Request completed', {
                method: 'demo', requestId: `sha256:${createHash('sha256').update(id).digest('hex')}`,
                durationMs: index === 0 ? 0 : 45, outcomeCode: 'ok', callerClass: 'unattributed',
            },
        ]));
        expect(JSON.stringify(logger.mock.calls)).not.toMatch(/never-log|private-session/);
    });

    it('reuses native relay UUIDs and captures denial at the real admission owner', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger, nowMs: () => 100,
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'machine', resolveCustodianAccountId: async () => 'private-owner',
                resolveInstallationId: () => null, verifyMachineAdmission: async () => true,
            }) });
        rpc.registerHandler('demo', () => { throw new Error('Must never dispatch'); });
        expect(await rpc.handleRequest({ method: 'machine:demo', params: {}, requestId: 'rpc_12345678-1234-4123-8123-123456789abc',
            callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'private-guest', custodianAccountId: 'private-owner',
                machineId: 'machine', installationId: 'private-installation', role: 'use', encryptionMode: 'plain' } }))
            .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', {
            method: 'demo', requestId: 'rpc_12345678-1234-4123-8123-123456789abc', durationMs: 0,
            outcomeCode: RPC_ERROR_CODES.FORBIDDEN, callerClass: 'unadmitted', admissionPredicate: 'machine_installation',
            failedPhase: 'authorize_request', cancelled: false,
            phaseDurationsMs: { request_admission: 0, authorize_request: 0 },
        }]]);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('private-');
    });

    it('captures an admitted guest and the failed disclosure predicate without error prose', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger,
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'machine', resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
                verifyMachineAdmission: async () => true,
            }) });
        rpc.registerHandler('demo', (_input, context) => {
            context?.reportAdmissionDenial?.('machine_currentness');
            throw new RpcError('never-log-token /home/private-user/workspace', RPC_ERROR_CODES.FORBIDDEN);
        });
        expect(await rpc.handleRequest({ method: 'machine:demo', params: {}, machineAdmission: { actorAccountId: 'guest',
            custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' } }))
            .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({
            method: 'demo', requestId: expect.any(String), outcomeCode: RPC_ERROR_CODES.FORBIDDEN,
            callerClass: 'machine_guest', admissionPredicate: 'machine_currentness',
        })]]);
        expect(JSON.stringify(logger.mock.calls)).not.toMatch(/never-log|private-user|workspace/);
    });

    it('bounds malformed routing and opaque ids and rejects arbitrary error code disclosure', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        await rpc.handleRequest({ method: 'machine:/home/never-log-path?token=never-log-token', params: {}, requestId: 'never-log-token\n' });
        rpc.registerHandler('demo', () => { throw new RpcError('never-log-error', 'never-log-secret-code'); });
        await rpc.handleRequest({ method: 'machine:demo', params: {} });
        expect(logger.mock.calls).toEqual([
            ['[RPC] Request completed', expect.objectContaining({ method: '<unregistered>', outcomeCode: RPC_ERROR_CODES.METHOD_NOT_FOUND })],
            ['[RPC] Request completed', expect.objectContaining({ method: 'demo', outcomeCode: 'unclassified_error' })],
        ]);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });

    it('uses the existing encrypted call id and leaves its response echo unchanged', async () => {
        const logger = vi.fn();
        const key = new Uint8Array(32).fill(7);
        const callId = '0123456789abcdef0123456789abcdef';
        const content: SocketRpcContent = { mode: 'e2ee', cipher: {
            encryptRaw: async value => encodeBase64(encrypt(key, 'dataKey', value)),
            decryptRaw: async value => decrypt(key, 'dataKey', decodeBase64(value)),
        } };
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionKey: key, encryptionVariant: 'dataKey', logger });
        rpc.registerHandler('demo', () => ({ ok: true }));
        const result = await rpc.handleRequest({ method: 'session:demo', params: await socketRpcCodec.encodeParams(content,
            { secret: 'never-log-input' }, { method: 'session:demo', callId }) });
        expect(await socketRpcCodec.decodeResult(content, { ok: true, result }, callId)).toEqual({ ok: true });
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({ requestId: callId, outcomeCode: 'ok' })]]);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });

    it('logs in-process dispatch and early content retirement once', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger });
        rpc.registerHandler('demo', () => ({ error: 'never-log-error', errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        await rpc.invokeLocal('demo', { token: 'never-log-payload' });
        rpc.retireEncryptionContext();
        await rpc.handleRequest({ method: 'machine:demo', params: {} });
        expect(logger.mock.calls).toEqual([
            ['[RPC] Request completed', expect.objectContaining({ method: 'demo', callerClass: 'local',
                outcomeCode: RPC_ERROR_CODES.FORBIDDEN, admissionPredicate: 'handler_admission' })],
            ['[RPC] Request completed', expect.objectContaining({ method: 'demo', outcomeCode: RPC_ERROR_CODES.UPDATE_REQUIRED })],
        ]);
    });

    it('retains a confidential admission predicate while preserving the closed response', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger,
            authorizeRequest: () => ({ ok: false, error: 'never-log-credential', errorCode: RPC_ERROR_CODES.FORBIDDEN }) });
        rpc.registerHandler(RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE, () => ({ ok: true }));
        expect(await rpc.handleRequest({ method: `session:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`, params: {},
            transportResponseEnvelopeVersion: 1 })).toEqual({ v: 1, result: {
            error: 'confidential_continuation_failed', errorCode: 'confidential_continuation_failed',
        } });
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({
            outcomeCode: 'confidential_continuation_failed', callerClass: 'unadmitted', admissionPredicate: 'authorize_request',
        })]]);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('never-log');
    });

    it('includes projection failure in the same safe completion record', async () => {
        const logger = vi.fn();
        const rpc = new RpcHandlerManager({ scopePrefix: 'private-session', encryptionMode: 'plain', logger,
            projectTransportAcknowledgement() { throw new Error('never-log-secret /home/private/work'); } });
        rpc.registerHandler('demo', () => ({ ok: true }));
        expect(await rpc.handleRequest({ method: 'private-session:demo', params: {}, transportResponseEnvelopeVersion: 1 }))
            .toEqual({ v: 1, result: { ok: true } });
        expect(logger.mock.calls).toEqual([['[RPC] Request completed', expect.objectContaining({
            method: 'demo', outcomeCode: 'ok', acknowledgementOutcomeCode: 'unclassified_error',
        })]]);
        expect(JSON.stringify(logger.mock.calls)).not.toMatch(/never-log|private-session|\/home/);
    });
});
