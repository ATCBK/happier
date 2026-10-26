import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { SessionInputMachineTargetV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { buildSessionInputAdmissionReceipt } from '../../../../../server/sources/app/session/messages/sessionInputAdmission';
import { isHostAuthoredInputMeta, readHostFollowInputMeta } from '@/sync/domains/session/input/hostAuthoredInput';
import { pendingDeliveryStatusV1ToPersistedFields } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import { SessionMessageReplyProgressV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { sessionPendingRoutes } from '../../../../../server/sources/app/api/routes/session/pendingRoutes';
import { enqueuePendingMessage } from '../../../../../server/sources/app/session/pending/pendingMessageService';
import { createPresentUserSessionAccessAuthentication } from '../../../../../server/sources/app/session/access/sessionAccessAuthentication.testkit';
import { db } from '../../../../../server/sources/storage/db';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getPendingMessageVisualState } from '@/components/sessions/pending/pendingMessageVisualState';
import { enqueuePendingMessageV2, fetchAndApplyPendingMessagesV2, markPendingDeliveryHandledV2 } from './pendingQueueV2';
import { loadPendingOutboxForSession } from '@/sync/domains/state/pendingOutboxPersistence';

let database: LightSqliteHarness;
beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'happier-r42-pending-', initAuth: true,
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
}, 180_000);
afterAll(async () => { if (database) await database.close(); });

it('projects real pending receipts and retains external enqueue custody until acknowledgement', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
        encryptionMode: 'plain', metadata: '{}' } });
    const localId = randomUUID();
    const enqueueOriginal = () => enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId,
        authentication: createPresentUserSessionAccessAuthentication(),
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'queued input' }, meta: {} } },
        requestedAction: { v: 1, kind: 'enqueue' } });
    expect(await enqueueOriginal()).toMatchObject({
            ok: true, pending: { recovery: { canSendAsNew: true } },
        });
    // Legacy role completion must retain the same recovery projection on rejoin.
    await db.sessionPendingMessage.update({
        where: { sessionId_localId: { sessionId: session.id, localId } }, data: { messageRole: null },
    });
    expect(await enqueueOriginal()).toMatchObject({
        ok: true, pending: { messageRole: 'user', recovery: { canSendAsNew: true } },
    });
    const app = createAuthenticatedTestApp();
    sessionPendingRoutes(app);
    await app.ready();
    // Only Home HTTP and device credentials are adapted. Route registration,
    // admission, schema, storage, scoped client, projection and policy stay real.
    const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: `https://${owner.id}.r42-pending.test`,
        accountId: owner.id, currentAccount: true }], route: async request => {
        const response = await app.inject({ method: request.method, url: request.url.pathname + request.url.search,
            headers: { 'x-test-user-id': request.accountId ?? '', 'x-happier-account-stored-content-protocol': '4' },
            ...(request.body === undefined ? {} : { payload: request.body }) });
        return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
    } });
    const home = homes.homes.home!;
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const account = await captureLazyActionAccountContext(home.id);
    const request = (path: string, init?: RequestInit) => account.request(path, init, { includeAuth: true });
    try {
        storage.getState().applySessions([createSessionFixture({ id: session.id, serverId: home.id,
            encryptionMode: 'plain', pendingVersion: 1, metadata: null })]);
        const refresh = () => fetchAndApplyPendingMessagesV2({ sessionId: session.id, encryption: null, request,
            outboxScope: account.accountLifetime.scope, isOutboxScopeCurrent: account.accountLifetime.isCurrent });
        await refresh();
        expect(storage.getState().sessionPending[session.id]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'queued input', pendingDeliveryStatus: 'server_queued' }),
        ]);
        // Recovery eligibility crosses the real DB -> route -> client projection.
        // A reply-bearing original cannot be copied; clearing custody refreshes eligibility.
        const reply = SessionMessageReplyProgressV1Schema.parse({ v: 1, mode: 'wait', disposition: 'observing' });
        for (const replyProgress of [null, reply, null]) {
            const current = await db.sessionPendingMessage.findUniqueOrThrow({
                where: { sessionId_localId: { sessionId: session.id, localId } },
            });
            await db.sessionPendingMessage.update({ where: { id: current.id }, data: { replyProgress } });
            await refresh();
            expect(storage.getState().sessionPending[session.id]?.messages[0]).toMatchObject({
                pendingRecovery: { canSendAsNew: replyProgress === null },
            });
        }
        const actionPath = `/v2/sessions/${session.id}/pending/${localId}/action`;
        const actionBody = JSON.stringify({ requestedAction: { v: 1, kind: 'send_now' } });
        const sent = await request(actionPath, { method: 'PATCH', body: actionBody });
        expect(sent.status).toBe(200);
        expect(PendingRequestedActionV1Schema.parse((await sent.json()).requestedAction)).toEqual({ v: 1, kind: 'send_now' });
        const stored = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } });
        expect(stored.requestedAction).toEqual({ v: 1, kind: 'send_now' });
        // A DB fixture publishes the canonical provider-custody fields; the
        // unchanged route must reject edits even without a concurrent user edit.
        await db.sessionPendingMessage.update({ where: { id: stored.id },
            data: { ...pendingDeliveryStatusV1ToPersistedFields({ status: 'delivering' }), providerAction: 'interrupt_and_send' } });
        await refresh();
        const delivering = storage.getState().sessionPending[session.id]?.messages[0];
        expect(delivering).toMatchObject({ localId, pendingDeliveryStatus: 'server_delivering' });
        if (!delivering) throw new Error('Expected real provider-custody projection');
        expect(getPendingMessageVisualState(delivering)).toMatchObject({ kind: 'delivering', deliveryMutationPolicy: 'effect_possible' });
        const stale = await request(actionPath, { method: 'PATCH', body: actionBody });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({ error: 'action-conflict' });

        // A transcript carrier can outlive its main runner's Machine tuple.
        // Browser-owned Voice reserves custody here before it starts its own
        // provider/run; this is not an input for the retired main runner.
        const retiredTarget = SessionInputMachineTargetV1Schema.parse({
            homeId: 'srv_retired_home', accountId: owner.id, sessionId: session.id,
            machineId: 'machine-1', installationId: 'retired-installation',
        });
        await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: retiredTarget } });
        storage.getState().applySessions([createSessionFixture({ id: session.id, serverId: home.id,
            encryptionMode: 'plain', active: false })]);
        const ordinary = await request(`/v2/sessions/${session.id}/pending`, { method: 'POST',
            body: JSON.stringify({ localId: randomUUID(), messageRole: 'user',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'main input' }, meta: {} } },
                requestedAction: { v: 1, kind: 'send_now' } }) });
        expect(ordinary.status).toBe(404);
        expect(await ordinary.json()).toMatchObject({ code: 'session_input_target_unavailable' });

        const handoffLocalId = randomUUID();
        let handoffBody: unknown;
        let outboxAtSnapshot: Awaited<ReturnType<typeof loadPendingOutboxForSession>> = [];
        const handoff = await enqueuePendingMessageV2({
            sessionId: session.id, localId: handoffLocalId, text: 'external input', encryption: null,
            outboxScope: account.accountLifetime.scope, serverWireMode: 'pending_input_v1',
            deliveryMode: 'external_handoff', requestedAction: { v: 1, kind: 'send_now' },
            metaOverrides: { claudeRemoteMaxThinkingTokens: 4096 },
            request: async (path, init) => {
                handoffBody = JSON.parse(String(init?.body));
                // The actual registered POST commits to SQLite before its ACK
                // reaches the client. A real GET then exposes that reservation.
                const acknowledgement = await request(path, init);
                await refresh();
                outboxAtSnapshot = await loadPendingOutboxForSession(session.id, account.accountLifetime.scope);
                return acknowledgement;
            },
        });
        expect(outboxAtSnapshot).toEqual([expect.objectContaining({ localId: handoffLocalId, operation: 'enqueue' })]);
        expect(handoff).toMatchObject({ accepted: true, externalHandoffClaimed: true });
        expect(handoffBody).not.toHaveProperty('targetMachineId');
        expect(handoff.settled).toBeUndefined();
        expect(await loadPendingOutboxForSession(session.id, account.accountLifetime.scope)).toEqual([]);
        expect(storage.getState().sessionPending[session.id]?.messages).toContainEqual(
            expect.objectContaining({ localId: handoffLocalId, text: 'external input', pendingDeliveryStatus: 'external_handoff' }),
        );
        const reserved = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: handoffLocalId } },
        });
        expect(reserved.deliveryState).toBe('external_handoff');
        expect(reserved.inputAdmissionReceipt).not.toHaveProperty('admittedTarget');
        expect(reserved.content).toMatchObject({
            t: 'plain', v: { meta: { claudeRemoteMaxThinkingTokens: 4096 } },
        });
        await markPendingDeliveryHandledV2({ sessionId: session.id, pendingId: handoffLocalId,
            encryption: null, request, outboxScope: account.accountLifetime.scope });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId: handoffLocalId } })).toBe(0);
        expect(await db.sessionMessage.count({ where: { sessionId: session.id, localId: handoffLocalId } })).toBe(1);

        // Existing clients may still send their old inferred Machine field.
        // It cannot turn caller-owned custody back into main-runner input.
        const legacyLocalId = randomUUID();
        const legacyBody = { localId: legacyLocalId, messageRole: 'user', targetMachineId: retiredTarget.machineId,
            deliveryMode: 'external_handoff', requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'legacy handoff' }, meta: {} } } };
        const legacy = await request(`/v2/sessions/${session.id}/pending`, { method: 'POST', body: JSON.stringify(legacyBody) });
        expect(legacy.status).toBe(200);
        expect(await legacy.json()).toMatchObject({ pending: { localId: legacyLocalId, deliveryStatus: { status: 'external_handoff' } } });
        // Read projection starts at an already-admitted stored receipt. Admission
        // policy is exercised by the server's Follow-original integration suite.
        // Real DB -> registered route -> UI ingress must preserve its host identity.
        const follow = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn',
            original: { sourceSessionId: 'worker', sourceTurn: { id: 'turn-1', status: 'completed' } },
            event: { kind: 'finished' } });
        const hostLocalId = randomUUID();
        const receipt = { ...buildSessionInputAdmissionReceipt({ issuer: 'authenticatedMachine',
            admittedTarget: retiredTarget }), followDeliveryV1: follow };
        await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId: hostLocalId,
            messageRole: 'user', position: 100, status: 'queued', authorAccountId: null,
            requestedAction: { v: 1, kind: 'enqueue' },
            inputAdmissionReceipt: receipt, content: { t: 'plain', v: { role: 'user',
                content: { type: 'text', text: 'Followed source changed' }, meta: {
                    happierInputRequestV1: { v: 1, producer: 'sessionAction', caller: { kind: 'host' },
                        permission: {}, followDeliveryV1: follow },
                    happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
                } } } } });
        await refresh();
        const host = storage.getState().sessionPending[session.id]?.messages.find(message => message.localId === hostLocalId);
        expect(host?.pendingHostFollowInput).toEqual(follow);
        expect(isHostAuthoredInputMeta(host?.rawRecord.meta, host?.pendingHostFollowInput)).toBe(true);
        expect(readHostFollowInputMeta(host?.rawRecord.meta, host?.pendingHostFollowInput)).toEqual(follow);
        const pendingRead = await request(`/v2/sessions/${session.id}/pending`);
        const pendingBody = await pendingRead.json() as { pending: unknown[] };
        expect(pendingBody.pending.find(row => typeof row === 'object' && row !== null && 'localId' in row && row.localId === hostLocalId))
            .not.toHaveProperty('inputAdmissionReceipt');
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const forbidden = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/pending`,
            headers: { 'x-test-user-id': stranger.id, 'x-happier-account-stored-content-protocol': '4' },
            payload: { ...legacyBody, localId: randomUUID() } });
        expect(forbidden.statusCode).toBe(404);
        await db.session.update({ where: { id: session.id }, data: { archivedAt: new Date() } });
        const archived = await request(`/v2/sessions/${session.id}/pending`, { method: 'POST',
            body: JSON.stringify({ ...legacyBody, localId: randomUUID() }) });
        expect(archived.status).toBe(400);
        expect(await archived.json()).toMatchObject({ code: 'session_input_archived' });
    } finally {
        account.dispose();
        await homes.dispose();
        await app.close();
    }
}, 180_000);
