import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentSessionRuntimeEventV1Schema, type AgentSessionRuntimeEvent } from '@happier-dev/protocol';
import Fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { auth } from '@/app/auth/auth';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { featuresRoutes } from '@/app/api/routes/features/featuresRoutes';
import { startSocket } from '@/app/api/socket';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { blockPendingDelivery, deletePendingMessage, enqueuePendingMessage, markPendingDeliveryHandled } from './pendingMessageService';
import { createPublicAcpSession } from '../../../../../cli/src/agent/acp/runtime/publicSession/createPublicAcpSession';
import { createNativeAgentSessionPublications } from '../../../../../cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createSessionTurnLifecycle } from '../../../../../cli/src/agent/runtime/session/turn/lifecycle';
import { createNativeAgentSessionOperations } from '../../../../../cli/src/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createPluginSessionMediaHostAdapter } from '../../../../../cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionMedia';
import { bindSessionProviderInputOutcome, createSessionProviderInputOutcomeNormalizer } from '../../../../../cli/src/agent/runtime/session/input/providerInputOutcome';
import { ApiSessionClient } from '../../../../../cli/src/api/session/sessionClient';
import { createSessionSocketTransport } from '../../../../../cli/src/api/session/connection/createSessionSocketTransport';
import { createInitialHostRuntimeActivityMutation } from '../../../../../cli/src/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { createTestMetadata } from '../../../../../cli/src/testkit/backends/sessionMetadata';
import { encodeBase64, encrypt } from '../../../../../cli/src/api/encryption';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { writeAcpTestAgentScript } from '../../../../../cli/src/agent/acp/testkit/subprocessHarness';
import { waitForCondition } from '../../../../../cli/src/testkit/async/waitFor';
import { MessageQueue2 } from '../../../../../cli/src/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '../../../../../cli/src/agent/runtime/session/input/sessionProviderInputConsumer';
import { createSessionProviderInputConsumerSessionAdapter } from '../../../../../cli/src/agent/runtime/waitForNextPermissionModeMessage';
import { createWorkflowOriginContextInputPort } from '../../../../../cli/src/agent/runtime/session/contextOnly/workflowOriginInput';
import { publishSessionFollowWakeInvalidation } from '../../../../../cli/src/agent/runtime/session/follow/sessionFollowWakeSignal';

describe('consumed ACP input → host turn → Pending', () => {
    let harness: LightSqliteHarness;
    let app: AppFastify;
    let origin: string;
    const clients = new Set<ApiSessionClient>();
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-consumed-input-', initAuth: true, initEncrypt: true });
        app = Fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        enableErrorHandlers(app);
        enableAuthentication(app);
        registerAccountEncryptionRoutes(app);
        registerSessionListingRoutes(app);
        registerSessionMessageRoutes(app);
        sessionPendingRoutes(app);
        featuresRoutes(app);
        startSocket(app);
        origin = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 120_000);
    afterAll(async () => { await app?.close(); await harness?.close(); });
    afterEach(async () => {
        await Promise.all([...clients].map(client => client.close()));
        clients.clear();
        vi.unstubAllEnvs();
    });

    it.each(['failed', 'lost', 'blocked', 'historical', 'recovered', 'recovery-lost', 'rejected', 'metadata-only-hard-cap'] as const)('settles only witnessed consumption (%s)', async scenario => {
        harness.resetEnv();
        if (scenario === 'metadata-only-hard-cap') vi.stubEnv('HAPPIER_ACP_TURN_HARD_CAP_TIMEOUT_MS', '250');
        const authentication = createPresentUserSessionAccessAuthentication();
        const accountSecret = new Uint8Array(32).fill(7);
        const sessionKey = new Uint8Array(32).fill(11);
        const metadata = createTestMetadata({ path: harness.baseDir });
        const sealInput = (text: string) => encodeBase64(encrypt(sessionKey, 'dataKey', { role: 'user', content: { type: 'text', text } }));
        const owner = await db.account.create({ data: createSignedAccountContentBinding(tweetnacl.box.keyPair.fromSecretKey(accountSecret).publicKey) });
        const session = await db.session.create({ data: { tag: randomUUID(), accountId: owner.id,
            metadata: encodeBase64(encrypt(sessionKey, 'dataKey', metadata)) } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials = { token, encryption: { type: 'legacy' as const, secret: accountSecret } };
        const client = new ApiSessionClient(token, {
            id: session.id, seq: 0, encryptionMode: 'e2ee', encryptionKey: sessionKey, encryptionVariant: 'dataKey',
            metadata, metadataVersion: 0, agentState: null, agentStateVersion: 0,
        }, {
            metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials },
            localMachineId: machine.id,
            initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
                sessionId: session.id, agentRuntimeApplicability: 'supported',
            })],
            transport: { serverId: 'consumed-input-home', serverUrl: origin, resolveToken: async () => token,
                createSessionSocketTransport: binding => createSessionSocketTransport({ ...binding, token, serverUrl: origin,
                    accessKeyBinding: 'preestablished' }) },
        });
        clients.add(client);
        expect(await client.claimCurrentSessionPublisherAuthorityForStartup()).toMatchObject({ status: 'claimed' });
        await client.updateRuntimeActivityProjection({ runtimeActivityState: 'idle', runtimeActivityActiveCount: 0 });
        const localId = `consumed-${randomUUID()}`;
        const retryLocalId = `${localId}-retry`;
        const responseReleasePath = join(harness.baseDir, `recovery-response-${session.id}`);
        const request = { actorUserId: owner.id, sessionId: session.id, localId, authentication };
        expect(await enqueuePendingMessage({ ...request, ciphertext: sealInput('original-input'), requestedAction: { v: 1, kind: 'send_now' } })).toMatchObject({ ok: true });
        expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force',
            deliveryTiming: 'after_foreground_ready' })).toMatchObject({ type: 'materialized', localId });
        if (scenario === 'blocked' || scenario === 'historical') {
            // Existing rows retain original input custody; later exact acceptance must
            // upgrade the same row, without copying input or changing its schema.
            const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } });
            await db.session.update({ where: { id: session.id }, data: { seq: 1 } });
            await db.sessionMessage.create({ data: { sessionId: session.id, localId, seq: 1, messageRole: 'user',
                content: pending.content, inputAdmissionReceipt: pending.inputAdmissionReceipt ?? undefined } });
            expect(await blockPendingDelivery({ ...request, reason: 'delivery_outcome_uncertain' })).toMatchObject({ ok: true });
        }
        expect(await deletePendingMessage({ ...request, withdraw: true })).toMatchObject({ ok: true, outcome: 'delivery_unknown' });
        if (scenario === 'historical') {
            // An exited producer cannot recreate its missing acceptance. Existing
            // explicit human settlement retires confirmed historical consumption
            // without dispatching the original input again or rewriting history.
            expect(await markPendingDeliveryHandled(request)).toMatchObject({ ok: true, didResolve: true, pendingCount: 0, pendingBlockedCount: 0 });
            expect(await deletePendingMessage({ ...request, withdraw: true })).toMatchObject({ outcome: 'already_delivered', pendingCount: 0 });
            expect(await db.sessionMessage.count({ where: { sessionId: session.id, localId } })).toBe(1);
            expect(await enqueuePendingMessage({ ...request, localId: `${localId}-retry`, ciphertext: sealInput('new-user-retry'),
                requestedAction: { v: 1, kind: 'send_now' } })).toMatchObject({ ok: true, pendingCount: 1, pendingBlockedCount: 0 });
            return;
        }

        // Only the external ACP process is simulated. Its output and typed request
        // error pass through the real transport, producer and host lifecycle.
        const script = writeAcpTestAgentScript({ dir: harness.baseDir, fileName: `consumed-${scenario}.mjs`, source: `
            import { createInterface } from 'node:readline';
            import { existsSync } from 'node:fs';
            const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
            let promptCount = 0;
            for await (const line of createInterface({ input: process.stdin })) {
                const request = JSON.parse(line);
                if (request.method === 'initialize') send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
                else if (request.method === 'session/new') send({ id: request.id, result: { sessionId: 'provider-consumed' } });
                else if (request.method === 'session/prompt') {
                    promptCount += 1;
                    if (${JSON.stringify(scenario)} === 'metadata-only-hard-cap') {
                        const metadata = () => {
                            for (const update of [{ sessionUpdate: 'current_mode_update', currentModeId: 'metadata-only-mode' },
                                { sessionUpdate: 'config_option_update', configOptions: [] }]) {
                                send({ method: 'session/update', params: { sessionId: request.params.sessionId, update } });
                            }
                        };
                        metadata();
                        setInterval(metadata, 20);
                        // Neither session/prompt nor session/cancel gets a reply.
                        // The existing hard cap must settle unknown custody itself.
                        continue;
                    }
                    if (${JSON.stringify(scenario)} === 'lost') process.exit(17);
                    if (promptCount > 1) {
                        if (${JSON.stringify(scenario)} === 'recovery-lost') process.exit(17);
                        send({ method: 'session/update', params: { sessionId: request.params.sessionId,
                            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recovered provider reply' } } } });
                        // Hold the external response until the host proves it has
                        // delivered the reply and settled exact successor custody.
                        const release = setInterval(() => {
                            if (!existsSync(${JSON.stringify(responseReleasePath)})) return;
                            clearInterval(release);
                            send({ id: request.id, result: { stopReason: 'end_turn' } });
                        }, 10);
                        continue;
                    }
                    if (${JSON.stringify(scenario)} !== 'rejected') send({ method: 'session/update', params: { sessionId: request.params.sessionId,
                        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial provider reply' } } } });
                    send({ id: request.id, error: { code: -32603, message: 'Cannot connect to API after output' } });
                }
            }
        ` });
        const signal = new AbortController().signal;
        const publications = createNativeAgentSessionPublications({ agentId: 'custom-acp', session: client, signal,
            isCurrent: () => true, supportsInFlightSteer: false });
        const media = createPluginSessionMediaHostAdapter({ agentId: 'custom-acp', readActiveScope: () => ({
            sessionId: session.id, rootPath: harness.baseDir,
            sendAgentSessionMediaCommitted: (provider, request) => client.sendAgentSessionMediaCommitted(provider, request),
        }) });
        const providerSession = await createPublicAcpSession({ kind: 'create', sessionId: session.id, cwd: harness.baseDir }, {
            transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture-acp' } },
        }, {
            pluginId: 'fixture.acp', agentId: 'custom-acp', signal, isCurrent: () => true,
            systemTools: { resolve: async () => ({ toolId: 'fixture-acp', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
            models: publications.services.models, modes: publications.services.modes,
            interactions: { request: async () => { throw new Error('No ACP permission request expected'); } },
            media: media.forAuthorizedSession(session.id, root => root === harness.baseDir),
        });
        const events: AgentSessionRuntimeEvent[] = [];
        const turn = createSessionTurnLifecycle({ agentId: 'custom-acp', onAcceptedTurnLifecycle: async () => {}, session: client });
        // This newTurn-only fixture selects no direct-control capabilities. The
        // runtime's direct-control context consumes only its real cancellation signal.
        const context = { signal } as AgentSessionRuntimeContext;
        const runtime = createNativeAgentSessionOperations(providerSession, session.id, undefined, undefined, undefined,
            undefined, undefined, {
                context, cwd: harness.baseDir, connectedAccounts: [],
                capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false },
            }, publications, [], {
                onTurnTerminal: () => undefined,
                getCommittedUserMessageSeq: localId => client.getCommittedUserMessageSeq(localId),
                subscribeCommittedUserMessageSeq: listener => client.subscribeCommittedUserMessageSeq(listener),
                subscribePendingProviderInputRetirement: listener => client.subscribePendingProviderInputRetirement(listener),
            });
        const unbindOutcome = bindSessionProviderInputOutcome({
            runtime,
            observe: createSessionProviderInputOutcomeNormalizer({ getTarget: () => client }),
            wakePendingMaterialization: () => client.wakePendingMaterialization(),
        });
        const unsubscribe = runtime.subscribeRuntimeEvents(raw => {
            const event = AgentSessionRuntimeEventV1Schema.parse(raw);
            events.push(event);
            turn.observeRuntimeEvent(event);
        });
        try {
            await runtime.sendTurnPrompt('reply', { localId, turnId: `turn-${localId}` });
            await waitForCondition(() => events.some(event => scenario === 'metadata-only-hard-cap'
                ? event.kind === 'input-custody-unknown' || event.kind === 'turn-failed'
                : event.kind === (scenario === 'lost' ? 'runtime-ended' : scenario === 'rejected' ? 'input-rejected' : 'turn-failed')),
                { timeoutMs: 5_000, intervalMs: 10, label: `ACP ${scenario}` });
            await client.flush();
            await turn.drainAcceptedLifecycle();
            const stored = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            if (scenario === 'rejected') {
                expect(stored).toMatchObject({ latestTurnId: null, pendingCount: 1, pendingBlockedCount: 1 });
                expect(events.some(event => event.kind === 'input-accepted' || event.kind === 'turn-start')).toBe(false);
                const source = createWorkflowOriginContextInputPort({
                    accountId: owner.id, originSessionId: session.id, machineId: machine.id,
                    storage: { execute: async () => ({ runs: [] }) },
                    resolveEncryption: async () => { throw new Error('No workflow rows'); },
                    readDispatchFact: async () => 'not_dispatched', onDispatchedInput() {},
                    onError: error => { throw error; },
                });
                publishSessionFollowWakeInvalidation();
                const queue = new MessageQueue2<string>(value => value);
                const waiting = new AbortController();
                let sourceReads = 0;
                const consumer = createSessionProviderInputConsumer({
                    messageQueue: queue,
                    session: createSessionProviderInputConsumerSessionAdapter(client),
                    beforePendingMaterialize: () => false,
                    waitForContextOnlyInputChange: signal => { sourceReads += 1; return source.waitForChange(signal); },
                    takeContextOnlyInput: async signal => { await source.take(signal); return null; },
                });
                const successor = consumer.waitForNextInput({ abortSignal: waiting.signal });
                try {
                    for (let step = 0; step < 100; step += 1) await Promise.resolve();
                    expect(sourceReads).toBe(0);
                    expect(await deletePendingMessage({ ...request, withdraw: true })).toMatchObject({ outcome: 'removed', pendingCount: 0 });
                    expect(await enqueuePendingMessage({ ...request, localId: retryLocalId, ciphertext: sealInput('new-user-retry'),
                        requestedAction: { v: 1, kind: 'send_now' } })).toMatchObject({ ok: true, pendingCount: 1, pendingBlockedCount: 0 });
                    // Direct owner fixture writes bypass route publication; refresh
                    // the real client before asking its observed drain gate.
                    await client.reconcilePendingQueueState({ force: true });
                    expect(client.getPendingQueueState()).toMatchObject({ pendingCount: 1, pendingBlockedCount: 0 });
                    expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force',
                        deliveryTiming: 'after_foreground_ready' })).toMatchObject({ type: 'materialized', localId: retryLocalId });
                    queue.pushImmediate(retryLocalId, 'mode');
                    const input = await successor;
                    expect(input?.message).toBe(retryLocalId);
                    await runtime.sendTurnPrompt('resend', { localId: input!.message, turnId: `turn-${retryLocalId}` });
                    await waitForCondition(() => events.some(event => event.kind === 'message-delta' && event.turnId === `turn-${retryLocalId}`),
                        { timeoutMs: 5_000, intervalMs: 10, label: 'rejected input successor reply' });
                    await client.flush();
                    expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ pendingCount: 0, pendingBlockedCount: 0 });
                    await writeFile(responseReleasePath, 'release');
                    await waitForCondition(() => events.some(event => event.kind === 'turn-complete' && event.turnId === `turn-${retryLocalId}`),
                        { timeoutMs: 5_000, intervalMs: 10, label: 'rejected input successor completion' });
                    await turn.drainAcceptedLifecycle();
                    expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ latestTurnStatus: 'completed', pendingCount: 0, pendingBlockedCount: 0 });
                } finally {
                    waiting.abort();
                    await successor;
                }
            } else if (scenario === 'lost' || scenario === 'metadata-only-hard-cap') {
                expect(stored).toMatchObject({ pendingCount: 1, pendingBlockedCount: 1 });
                expect(events).toContainEqual(expect.objectContaining({ kind: 'input-custody-unknown', inputIds: [localId] }));
                expect(events.some(event => event.kind === 'input-accepted' || event.kind === 'turn-start')).toBe(false);
                expect(await deletePendingMessage({ ...request, withdraw: true })).toMatchObject({ outcome: 'delivery_unknown' });
            } else {
                expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', text: 'partial provider reply' }));
                expect(stored).toMatchObject({ latestTurnStatus: 'failed', pendingCount: 0, pendingBlockedCount: 0 });
                expect(JSON.parse(stored.lastRuntimeIssue!)).toMatchObject({ code: 'acp_turn_failed', sanitizedPreview: expect.stringContaining('Cannot connect to API after output') });
                expect(await deletePendingMessage({ ...request, withdraw: true })).toMatchObject({ outcome: 'already_delivered', pendingCount: 0 });
                expect(await db.sessionMessage.count({ where: { sessionId: session.id, localId } })).toBe(1);
                expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).toBe(0);
                expect(await enqueuePendingMessage({ ...request, localId: retryLocalId, ciphertext: sealInput('new-user-retry'),
                    requestedAction: { v: 1, kind: 'send_now' } })).toMatchObject({ ok: true, pendingCount: 1, pendingBlockedCount: 0 });
                if (scenario === 'recovered' || scenario === 'recovery-lost') {
                    const retryRequest = { ...request, localId: retryLocalId };
                    expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force',
                        deliveryTiming: 'after_foreground_ready' })).toMatchObject({ type: 'materialized', localId: retryLocalId });
                    await runtime.sendTurnPrompt('resend', { localId: retryLocalId, turnId: `turn-${retryLocalId}` });
                    if (scenario === 'recovered') {
                        await waitForCondition(() => events.some(event => event.kind === 'message-delta' && event.turnId === `turn-${retryLocalId}`),
                            { timeoutMs: 5_000, intervalMs: 10, label: 'successor reply before prompt response' });
                        await client.flush();
                        await turn.drainAcceptedLifecycle();
                        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ pendingCount: 0, pendingBlockedCount: 0 });
                        expect(events.some(event => event.kind === 'turn-complete' && event.turnId === `turn-${retryLocalId}`)).toBe(false);
                        await writeFile(responseReleasePath, 'release');
                    }
                    await waitForCondition(() => events.some(event => event.kind === (scenario === 'recovered' ? 'turn-complete' : 'runtime-ended')),
                        { timeoutMs: 5_000, intervalMs: 10, label: `ACP ${scenario} successor` });
                    await client.flush();
                    await turn.drainAcceptedLifecycle();
                    const recovered = await db.session.findUniqueOrThrow({ where: { id: session.id } });
                    if (scenario === 'recovered') {
                        expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', turnId: `turn-${retryLocalId}`,
                            text: 'recovered provider reply' }));
                        expect(recovered).toMatchObject({ latestTurnStatus: 'completed', pendingCount: 0, pendingBlockedCount: 0 });
                        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId: retryLocalId } })).toBe(0);
                        expect(await db.sessionMessage.count({ where: { sessionId: session.id, localId: retryLocalId } })).toBe(1);
                        expect(await deletePendingMessage({ ...retryRequest, withdraw: true })).toMatchObject({ outcome: 'already_delivered', pendingCount: 0 });
                    } else {
                        expect(recovered).toMatchObject({ pendingCount: 1, pendingBlockedCount: 1 });
                        expect(events).toContainEqual(expect.objectContaining({ kind: 'input-custody-unknown', inputIds: [retryLocalId] }));
                        expect(events.some(event => event.kind === 'input-accepted' && event.inputIds.includes(retryLocalId))).toBe(false);
                        expect(await deletePendingMessage({ ...retryRequest, withdraw: true })).toMatchObject({ outcome: 'delivery_unknown', pendingCount: 1 });
                    }
                }
            }
        } finally {
            unsubscribe();
            unbindOutcome();
            await runtime.resetOrDisposeRuntime('session_closed');
            media.dispose();
            publications.dispose();
        }
    });
});
