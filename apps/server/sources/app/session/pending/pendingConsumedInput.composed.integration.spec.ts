import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentSessionRuntimeEventV1Schema, type AgentSessionRuntimeEvent } from '@happier-dev/protocol';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { applySessionTurnMutation } from '@/app/session/sessionWriteService';
import { blockPendingDelivery, deletePendingMessage, enqueuePendingMessage, markPendingDeliveryHandled, materializeNextPendingMessage,
    resolveAcceptedPendingDelivery } from './pendingMessageService';
import { createPublicAcpSession } from '../../../../../cli/src/agent/acp/runtime/publicSession/createPublicAcpSession';
import { createNativeAgentSessionPublications } from '../../../../../cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createSessionTurnLifecycle } from '../../../../../cli/src/agent/runtime/session/turn/lifecycle';
import { createAgentSessionTurnInvariant } from '../../../../../cli/src/agent/runtime/session/turn/agentSessionTurnInvariant';
import { createSessionProviderInputOutcomeNormalizer } from '../../../../../cli/src/agent/runtime/session/input/providerInputOutcome';
import { writeAcpTestAgentScript } from '../../../../../cli/src/agent/acp/testkit/subprocessHarness';
import { waitForCondition } from '../../../../../cli/src/testkit/async/waitFor';
import { SessionMessageAcceptedDeliveryFactsV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';

describe('consumed ACP input → host turn → Pending', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-consumed-input-', initAuth: true }); }, 120_000);
    afterAll(async () => { await harness.close(); });

    it.each(['failed', 'lost', 'blocked', 'historical', 'recovered', 'recovery-lost'] as const)('settles only witnessed consumption (%s)', async scenario => {
        harness.resetEnv();
        const authentication = createPresentUserSessionAccessAuthentication();
        const owner = await db.account.create({ data: createSignedAccountContentBinding() });
        const session = await db.session.create({ data: { tag: randomUUID(), accountId: owner.id, metadata: '{}' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const binding = { accountId: owner.id, machineId: machine.id, sessionId: session.id };
        const presence = createSessionPublisherPresence();
        const socket = {};
        const registered = await presence.registerPublisher({ socket, binding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (registered.status !== 'registered') throw new Error(`publisher ${registered.status}`);
        const publisherAuthority = { ...binding, socket, presence, committedFence: registered.committedFence };
        const localId = `consumed-${randomUUID()}`;
        const retryLocalId = `${localId}-retry`;
        const responseReleasePath = join(harness.baseDir, `recovery-response-${session.id}`);
        const request = { actorUserId: owner.id, sessionId: session.id, localId, authentication };
        expect(await enqueuePendingMessage({ ...request, ciphertext: 'original-input', requestedAction: { v: 1, kind: 'send_now' } })).toMatchObject({ ok: true });
        expect(await materializeNextPendingMessage({ ...request, publisherAuthority, deliveryState: 'provider',
            deliveryTiming: 'after_foreground_ready', foregroundState: 'ready',
            expectedRuntimeActivityRevision: registered.activity.projection.runtimeActivityRevision })).toMatchObject({ ok: true });
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
            expect(await enqueuePendingMessage({ ...request, localId: `${localId}-retry`, ciphertext: 'new-user-retry',
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
                    send({ method: 'session/update', params: { sessionId: request.params.sessionId,
                        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial provider reply' } } } });
                    send({ id: request.id, error: { code: -32603, message: 'Cannot connect to API after output' } });
                }
            }
        ` });
        const signal = new AbortController().signal;
        const publications = createNativeAgentSessionPublications({ agentId: 'custom-acp', session: null, signal,
            isCurrent: () => true, supportsInFlightSteer: false });
        const runtime = await createPublicAcpSession({ kind: 'create', sessionId: session.id, cwd: harness.baseDir }, {
            transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture-acp' } },
        }, {
            pluginId: 'fixture.acp', agentId: 'custom-acp', signal, isCurrent: () => true,
            systemTools: { resolve: async () => ({ toolId: 'fixture-acp', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
            models: publications.services.models, modes: publications.services.modes,
            interactions: { request: async () => { throw new Error('No ACP permission request expected'); } },
            media: { registerSourceRoot: async () => ({ publishGenerated: async () => ({ status: 'published' }), dispose() {} }) },
        });
        const events: AgentSessionRuntimeEvent[] = [];
        const invariant = createAgentSessionTurnInvariant({ sessionId: session.id });
        const writes: Promise<unknown>[] = [];
        const turn = createSessionTurnLifecycle({ agentId: 'custom-acp', onAcceptedTurnLifecycle: async () => {}, session: {
            sessionId: session.id, enqueueSessionTurnMutation: async mutation => {
                const result = await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation });
                expect(result).toMatchObject({ ok: true });
            },
        } });
        const observe = createSessionProviderInputOutcomeNormalizer({ getTarget: () => ({
            sessionId: session.id, hasPendingProviderInput: inputId => inputId === localId || inputId === retryLocalId,
            observeProviderInputSettlement: outcome => {
                if (outcome.kind === 'accepted') {
                    SessionMessageAcceptedDeliveryFactsV1Schema.parse({ v: 1, acceptedAtMs: outcome.acceptedAtMs,
                        delivery: { kind: outcome.providerDeliveryKind, turnId: outcome.providerTurnId } });
                    // E2EE sealing is a transport boundary; Server cannot decrypt it.
                    writes.push(resolveAcceptedPendingDelivery({ ...request, localId: outcome.localId, publisherAuthority,
                        acceptedDelivery: { t: 'encrypted', c: 'sealed-exact-acceptance' } }).then(result => {
                        expect(result).toMatchObject({ ok: true, didResolve: true });
                    }));
                } else if (outcome.kind === 'effect_may_have_occurred') {
                    writes.push(blockPendingDelivery({ ...request, localId: outcome.localId, reason: 'delivery_outcome_uncertain' }));
                }
            },
        }) });
        const subscription = runtime.watch(raw => {
            const event = AgentSessionRuntimeEventV1Schema.parse(raw);
            expect(invariant.observe(event).status).not.toBe('rejected');
            events.push(event);
            if (event.kind === 'input-accepted') observe({ type: event.kind, localId: event.inputIds[0], userMessageSeq: null,
                delivery: event.delivery, acceptedAtMs: event.emittedAtMs });
            else if (event.kind === 'input-custody-unknown') observe({ type: event.kind, localId: event.inputIds[0],
                userMessageSeq: null, issue: event.issue });
            turn.observeRuntimeEvent(event);
        });
        try {
            await runtime.send({ inputIds: [localId], input: { text: 'reply' }, delivery: { kind: 'newTurn', turnId: `turn-${localId}` } });
            await waitForCondition(() => events.some(event => event.kind === (scenario === 'lost' ? 'runtime-ended' : 'turn-failed')),
                { timeoutMs: 5_000, intervalMs: 10, label: `ACP ${scenario}` });
            await Promise.all(writes);
            await turn.drainAcceptedLifecycle();
            const stored = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            if (scenario === 'lost') {
                expect(stored).toMatchObject({ pendingCount: 1, pendingBlockedCount: 1 });
                expect(events.some(event => event.kind === 'input-accepted' || event.kind === 'turn-start')).toBe(false);
                expect(await deletePendingMessage({ ...request, withdraw: true })).toMatchObject({ outcome: 'delivery_unknown' });
            } else {
                expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', text: 'partial provider reply' }));
                expect(stored).toMatchObject({ latestTurnStatus: 'failed', pendingCount: 0, pendingBlockedCount: 0 });
                expect(JSON.parse(stored.lastRuntimeIssue!)).toMatchObject({ code: 'acp_turn_failed', sanitizedPreview: expect.stringContaining('Cannot connect to API after output') });
                expect(await deletePendingMessage({ ...request, withdraw: true })).toMatchObject({ outcome: 'already_delivered', pendingCount: 0 });
                expect(await db.sessionMessage.count({ where: { sessionId: session.id, localId } })).toBe(1);
                expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).toBe(0);
                expect(await enqueuePendingMessage({ ...request, localId: retryLocalId, ciphertext: 'new-user-retry',
                    requestedAction: { v: 1, kind: 'send_now' } })).toMatchObject({ ok: true, pendingCount: 1, pendingBlockedCount: 0 });
                if (scenario === 'recovered' || scenario === 'recovery-lost') {
                    const retryRequest = { ...request, localId: retryLocalId };
                    expect(await materializeNextPendingMessage({ ...retryRequest, publisherAuthority, deliveryState: 'provider',
                        deliveryTiming: 'after_foreground_ready', foregroundState: 'ready',
                        expectedRuntimeActivityRevision: registered.activity.projection.runtimeActivityRevision })).toMatchObject({ ok: true });
                    await runtime.send({ inputIds: [retryLocalId], input: { text: 'resend' },
                        delivery: { kind: 'newTurn', turnId: `turn-${retryLocalId}` } });
                    if (scenario === 'recovered') {
                        await waitForCondition(() => events.some(event => event.kind === 'message-delta' && event.turnId === `turn-${retryLocalId}`),
                            { timeoutMs: 5_000, intervalMs: 10, label: 'successor reply before prompt response' });
                        await Promise.all(writes);
                        await turn.drainAcceptedLifecycle();
                        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ pendingCount: 0, pendingBlockedCount: 0 });
                        expect(events.some(event => event.kind === 'turn-complete' && event.turnId === `turn-${retryLocalId}`)).toBe(false);
                        await writeFile(responseReleasePath, 'release');
                    }
                    await waitForCondition(() => events.some(event => event.kind === (scenario === 'recovered' ? 'turn-complete' : 'runtime-ended')),
                        { timeoutMs: 5_000, intervalMs: 10, label: `ACP ${scenario} successor` });
                    await Promise.all(writes);
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
            subscription.dispose();
            await runtime.dispose();
            publications.dispose();
        }
    });
});
