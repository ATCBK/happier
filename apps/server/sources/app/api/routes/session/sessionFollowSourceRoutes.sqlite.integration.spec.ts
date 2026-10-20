import { createHash, randomUUID } from 'node:crypto';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { SessionFollowObserveInactiveResponseV1Schema, SessionFollowAdmittedRunInputAcknowledgeRequestV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SessionFollowRunOccurrenceRoutesResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { SessionFollowRelationWitnessesV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import { SessionFollowInputV1Schema, deriveSessionFollowInputLocalIdV1, deriveSessionFollowOriginalOccurrenceKeyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { acknowledgeAdmittedSessionFollowInputInTx, observePendingSessionFollowForDestinationInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { inTx } from '@/storage/inTx';
import { enqueuePendingMessage } from '@/app/session/pending/pendingMessageService';
import { parseSessionFollowActionResponse, resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { setSessionManager } from '@/app/session/follow/sessionManagerService';
import { acceptAccountSessionFollowOnceDelivery, getAccountSessionFollow, removeAccountSessionFollow, setAccountSessionFollow } from '@/app/session/follow/accountFollowService';
import { changeDeliveryMute } from '@/app/session/follow/sessionDeliveryMuteService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';

import type { FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerSessionFollowSourceRoutes } from './registerSessionFollowSourceRoutes';
import { registerSessionFollowRoutes } from './registerSessionFollowRoutes';
import type { Fastify as AppFastify } from '@/app/api/types';
import { registerPublicShareReadRoutes } from '../share/registerPublicShareReadRoutes';
import { createPublicShareMessagesAccessToken, PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER, requirePublicShareAccessGrantSecret } from '../share/publicShareMessageAccessGrant';

async function createAccount() {
    return await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
}

async function createSession(accountId: string, overrides: Record<string, unknown> = {}) {
    return await db.session.create({
        data: { accountId, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain', ...overrides },
    });
}

async function buildApp(accountId: string, forwardRpcForUser?: AppFastify['forwardRpcForUser']) {
    const app = createAuthenticatedTestApp();
    if (forwardRpcForUser) app.decorate('forwardRpcForUser', forwardRpcForUser);
    app.addHook('onRequest', async (request: FastifyRequest) => { request.headers['x-test-user-id'] = accountId; });
    registerSessionFollowSourceRoutes(app);
    registerSessionFollowRoutes(app);
    registerPublicShareReadRoutes(app);
    await app.ready();
    return app;
}

describe('Session Follow source routes', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-session-follow-routes-',
            env: { HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_SERVER_IDENTITY_ID: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        });
    }, 180_000);

    afterEach(async () => {
        await db.userKVStore.deleteMany();
        await db.sessionPendingMessage.deleteMany();
        await db.sessionMessage.deleteMany();
        await db.sessionFollowEdge.deleteMany();
        await db.accessKey.deleteMany();
        await db.machine.deleteMany();
        await db.sessionShare.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => harness.close());

    it.each(['execution_run', 'workflow_run'] as const)('reads a stored %s Follow at its exact terminal original, respecting mute and removal', async kind => {
        const owner = await createAccount();
        const parent = await createSession(owner.id, { publisherGeneration: 1n });
        const destination = await createSession(owner.id);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1,
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: parent.id, data: 'opaque' } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: destination.id, data: 'opaque' } });
        await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: {
            homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: owner.id, sessionId: destination.id,
            machineId: machine.id, installationId: machine.installationId! } } });
        await db.session.update({ where: { id: parent.id }, data: { runtimeMachineTarget: {
            homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: owner.id, sessionId: parent.id,
            machineId: machine.id, installationId: machine.installationId! } } });
        const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct',
            automationId: null, causeKind: null, causeOccurredAt: null,
            workflowAcceptedSnapshotEnvelope: '{}', state: 'running', workflowCustodyState: 'pending',
            scheduledAt: new Date(), dueAt: new Date(), revision: 3 } });
        let terminal = false;
        const app = await buildApp(owner.id, async () => ({ ok: true, result: {
            sessionId: parent.id, runId: 'followed-run', status: terminal ? 'succeeded' : 'running',
            terminalEventId: terminal ? 'terminal-original' : null,
        } }));
        const source = kind === 'execution_run' ? { kind, sessionId: parent.id, runId: 'followed-run' }
            : { kind, runId: run.id };
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const policy = { preset: 'important' as const };
        const path = resolveSessionFollowActionRequest('follow.set', { receiver, source, policy }).path;
        const original = kind === 'execution_run' ? { source, terminalEventId: 'terminal-original' } : { source, revision: 4 };
        const read = () => app.inject({ method: 'POST', url: SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.runOccurrenceRoutes,
            payload: { v: 1, original } });
        try {
            expect((await app.inject({ method: 'PUT', url: path, payload: { policy } })).statusCode).toBe(200);
            terminal = true;
            await db.automationRun.update({ where: { id: run.id }, data: { revision: 4, state: 'succeeded' } });
            const response = await read();
            expect(response.statusCode, response.body).toBe(200);
            expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.parse(response.json())).toMatchObject({
                ok: true, original, routes: [{ destinationSessionId: destination.id, policy,
                    ...(kind === 'execution_run' ? { expectedTerminalEventId: null } : { expectedRevision: 3 }) }],
            });
            const routes = SessionFollowRunOccurrenceRoutesResponseV1Schema.parse(response.json());
            if (!routes.ok) throw new Error('Expected admitted source routes');
            const route = routes.routes[0]!;
            const delivery = SessionFollowInputV1Schema.parse({ v: 1, original, event: { kind: 'finished' }, delivery: 'next_turn' });
            const enqueue = () => enqueuePendingMessage({ actorUserId: owner.id, sessionId: destination.id,
                followSourceApp: app, authentication: createPresentUserSessionAccessAuthentication({ env: {} }),
                localId: deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original: delivery.original }),
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Run finished' } } },
                messageRole: 'user', requestedAction: { v: 1, kind: 'enqueue' }, followDeliveryV1: delivery,
                followRelations: SessionFollowRelationWitnessesV1Schema.parse([{ relation: route.relation, source,
                    attachedAt: route.attachedAt, ...('expectedRevision' in route ? { expectedRevision: route.expectedRevision }
                        : { expectedTerminalEventId: route.expectedTerminalEventId }) }]),
            });
            const admitted = await enqueue();
            expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true, didWrite: true });
            expect(await enqueue()).toMatchObject({ ok: true, didWrite: false });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id } })).toBe(1);
            const pending = await db.sessionPendingMessage.findFirstOrThrow({ where: { sessionId: destination.id } });
            const principal = { kind: 'destination_runtime' as const, destinationRuntimeAccountId: owner.id,
                authentication: createPresentUserSessionAccessAuthentication({ env: {} }) };
            const observe = () => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal, destinationSessionId: destination.id, inputLocalIds: [pending.localId] }));
            expect((await observe()).observations).toContainEqual({ kind: 'admitted_run_input',
                destinationSessionId: destination.id, localInputId: pending.localId, delivery });
            const acknowledge = () => inTx(tx => acknowledgeAdmittedSessionFollowInputInTx(tx, { principal,
                request: SessionFollowAdmittedRunInputAcknowledgeRequestV1Schema.parse({ v: 1, destinationSessionId: destination.id, localInputId: pending.localId,
                    expectedPublisherGeneration: destination.publisherGeneration.toString(), original: delivery.original,
                    acceptance: { kind: 'admitted_input', localInputId: pending.localId, userMessageSeq: 1 } }) }));
            expect(await acknowledge()).toMatchObject({ ok: false, rejection: 'provider_acceptance_unverified' });
            // The persistent database is the native transport boundary here:
            // retain the real Pending receipt with its exact original acceptance.
            await db.sessionMessage.create({ data: { sessionId: destination.id, localId: pending.localId, seq: 1,
                messageRole: 'user', content: pending.content, inputAdmissionReceipt: pending.inputAdmissionReceipt!,
                acceptedFollowOriginalKey: deriveSessionFollowOriginalOccurrenceKeyV1(delivery.original),
                deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: { v: 1,
                    acceptedAtMs: 1, delivery: { kind: 'newTurn', turnId: 'native-accepted-turn' } } } } } });
            await db.sessionPendingMessage.delete({ where: { id: pending.id } });
            expect(await acknowledge()).toMatchObject({ ok: true });
            expect(await acknowledge()).toMatchObject({ ok: true });
            expect((await read()).json()).toMatchObject({ ok: true, routes: [] });
            expect(await changeDeliveryMute({ accountId: owner.id, receiver, scope: { kind: 'source', source },
                operation: 'set', authentication: createPresentUserSessionAccessAuthentication({ env: {} }) })).toMatchObject({ ok: true });
            expect((await read()).json()).toMatchObject({ ok: true, routes: [] });
            expect((await app.inject({ method: 'DELETE', url: path })).statusCode).toBe(200);
            expect((await read()).json()).toMatchObject({ ok: true, routes: [] });
        } finally { await app.close(); }
    });

    it.each(['account', 'session'] as const)('keeps an exact retained Execution Run source for a %s receiver', async kind => {
        const owner = await createAccount();
        const parent = await createSession(owner.id, { publisherGeneration: 1n });
        const destination = await createSession(owner.id);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: parent.id, data: 'opaque' } });
        await db.session.update({ where: { id: parent.id }, data: { runtimeMachineTarget: {
            homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: owner.id, sessionId: parent.id,
            machineId: machine.id, installationId: machine.installationId! } } });
        const source = { kind: 'execution_run' as const, sessionId: parent.id, runId: 'exact-run' };
        const receiver = kind === 'account' ? { kind: 'account' as const }
            : { kind: 'session' as const, sessionId: destination.id };
        const policy = { preset: 'important' as const };
        let online = true;
        let wrongRun = true;
        const app = await buildApp(owner.id, async () => {
            if (!online) throw new Error('Machine transport disconnected');
            return { ok: true, result: {
                sessionId: parent.id, runId: wrongRun ? 'another-run' : source.runId,
                status: 'succeeded', terminalEventId: 'retained-terminal',
            } };
        });
        const path = resolveSessionFollowActionRequest('follow.set', { receiver, source, policy }).path;
        try {
            // Parent readability alone cannot fabricate Run identity or seed its original frontier.
            expect((await app.inject({ method: 'PUT', url: path, payload: { policy } })).statusCode).toBe(409);
            wrongRun = false;
            const saved = await app.inject({ method: 'PUT', url: path, payload: { policy } });
            expect(saved.statusCode, saved.body).toBe(200);
            const parsed = parseSessionFollowActionResponse('follow.set', { receiver, source, policy }, saved.json());
            expect(parsed).toMatchObject(kind === 'account' ? { follow: { source, policy } } : { source: { source, policy } });
            const key = sourceKeyForSessionFollowSourceV1(source);
            const row = kind === 'account'
                ? await db.accountSessionFollow.findUnique({ where: { accountId_sourceKey: { accountId: owner.id, sourceKey: key } } })
                : await db.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceKey_relation: {
                    destinationSessionId: destination.id, sourceKey: key, relation: 'follower' } } });
            expect(row).toMatchObject({ sourceExecutionRunSessionId: parent.id, sourceExecutionRunId: source.runId,
                deliveredExecutionRunTerminalEventId: 'retained-terminal' });
            expect(parseSessionFollowActionResponse('follow.get', { receiver, source },
                (await app.inject({ method: 'GET', url: path })).json()))
                .toMatchObject(kind === 'account' ? { follow: { source } } : { source: { source } });
            const listInput = { direction: 'following' as const, receiver };
            const listed = await app.inject({ method: 'GET', url: resolveSessionFollowActionRequest('follow.list', listInput).path });
            expect(parseSessionFollowActionResponse('follow.list', listInput, { ...listed.json(), rules: [],
                ...(kind === 'account' ? { sources: [] } : { follows: [] }), coverage: 'complete' }))
                .toMatchObject(kind === 'account' ? { follows: [{ source }] } : { sources: [{ source }] });
            online = false;
            expect((await app.inject({ method: 'PUT', url: path, payload: { policy: { preset: 'quiet' } } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'DELETE', url: path })).json()).toEqual({ changed: true });
            if (kind === 'account') {
                // Restoring an opt-out needs a fresh frontier, while editing an active choice does not.
                expect((await app.inject({ method: 'PUT', url: path, payload: { policy } })).statusCode).toBe(409);
            }
        } finally { await app.close(); }
    });

    it('authors one exact Discussion source through the existing Follow edge', async () => {
        const owner = await createAccount();
        const destination = await createSession(owner.id);
        const discussion = await db.discussion.create({ data: {
            ownerAccountId: owner.id, encryptionMode: 'plain',
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            creationLocalId: randomUUID(), creationEqualityEvidenceV1: {},
            titleContent: { t: 'plain', v: 'Discussion' }, lastMessageAt: new Date(), messageSeq: 3,
        } });
        await db.discussionParticipant.create({ data: { discussionId: discussion.id,
            participantSlotId: 'participant-1', sessionId: destination.id } });
        const app = await buildApp(owner.id);
        const source = { kind: 'discussion' as const, discussionId: discussion.id };
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const input = { receiver, source, policy: { preset: 'everything' as const } };
        const path = resolveSessionFollowActionRequest('follow.set', input).path;
        try {
            const set = await app.inject({ method: 'PUT', url: path, payload: { policy: input.policy } });
            expect(set.statusCode).toBe(200);
            expect(parseSessionFollowActionResponse('follow.set', input, set.json())).toMatchObject({
                changed: true, source: { source, destinationSessionId: destination.id, hasPendingUpdates: false,
                    sourceAvailability: 'available' },
            });
            expect(await db.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceKey_relation: {
                destinationSessionId: destination.id, sourceKey: sourceKeyForSessionFollowSourceV1(source), relation: 'follower',
            } } })).toMatchObject({ sourceDiscussionId: discussion.id, sourceSessionId: null, deliveredTranscriptSeq: 3 });
            const get = await app.inject({ method: 'GET', url: path });
            expect(parseSessionFollowActionResponse('follow.get', { receiver, source }, get.json())).toMatchObject({
                source: { source, policy: input.policy },
            });
            const listInput = { direction: 'following' as const, receiver };
            const listRequest = resolveSessionFollowActionRequest('follow.list', listInput);
            const listed = await app.inject({ method: listRequest.method, url: listRequest.path });
            expect(listed.statusCode).toBe(200);
            expect(listed.json().sources).toEqual([expect.objectContaining({ source })]);
            const removed = await app.inject({ method: 'DELETE', url: path });
            expect(parseSessionFollowActionResponse('follow.remove', { receiver, source }, removed.json())).toEqual({ changed: true });
            expect((await app.inject({ method: 'GET', url: path })).json()).toEqual({ source: null });
        } finally { await app.close(); }
    });

    it('authors a Workflow Run from its current revision and lists only later progress', async () => {
        const owner = await createAccount();
        const destination = await createSession(owner.id);
        const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct',
            automationId: null, causeKind: null, causeOccurredAt: null,
            workflowAcceptedSnapshotEnvelope: '{}', state: 'running', workflowCustodyState: 'pending',
            scheduledAt: new Date(), dueAt: new Date(), revision: 3 } });
        const app = await buildApp(owner.id);
        const source = { kind: 'workflow_run' as const, runId: run.id };
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const policy = { preset: 'everything' as const };
        const path = resolveSessionFollowActionRequest('follow.set', { receiver, source, policy }).path;
        try {
            const saved = await app.inject({ method: 'PUT', url: path, payload: { policy } });
            expect(saved.statusCode, saved.body).toBe(200);
            expect(parseSessionFollowActionResponse('follow.set', { receiver, source, policy }, saved.json()))
                .toMatchObject({ changed: true, source: { source, sourceAvailability: 'available', hasPendingUpdates: false } });
            expect(await db.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceKey_relation: {
                destinationSessionId: destination.id, sourceKey: sourceKeyForSessionFollowSourceV1(source), relation: 'follower',
            } } })).toMatchObject({ sourceSessionId: null, sourceWorkflowRunId: run.id, deliveredWorkflowRunRevision: 3 });
            await db.automationRun.update({ where: { id: run.id }, data: { revision: 4 } });
            const get = await app.inject({ method: 'GET', url: path });
            expect(parseSessionFollowActionResponse('follow.get', { receiver, source }, get.json()))
                .toMatchObject({ source: { source, hasPendingUpdates: true } });
            const listInput = { direction: 'following' as const, receiver };
            const listRequest = resolveSessionFollowActionRequest('follow.list', listInput);
            const listed = await app.inject({ method: listRequest.method, url: listRequest.path });
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json().sources).toEqual([expect.objectContaining({ source })]);
            expect((await app.inject({ method: 'DELETE', url: path })).json()).toEqual({ changed: true });
            expect((await app.inject({ method: 'GET', url: path })).json()).toEqual({ source: null });
        } finally { await app.close(); }
    });

    it('reads authorized Session followers and anonymous people only, readmitting source and receiver access', async () => {
        const owner = await createAccount();
        const viewer = await createAccount();
        const source = await createSession(owner.id);
        const visible = await createSession(owner.id);
        const hidden = await createSession(owner.id);
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const app = await buildApp(owner.id);
        const viewerApp = await buildApp(viewer.id);
        try {
            for (const destination of [visible, hidden]) expect((await app.inject({ method: 'PUT',
                url: `/v2/sessions/${destination.id}/follows/sessions/${source.id}`, payload: { policy: { preset: 'quiet' } } })).statusCode).toBe(200);
            expect(await setSessionManager({ accountId: owner.id, sessionId: source.id, managerSessionId: visible.id,
                expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
            for (const session of [source, visible]) await db.sessionShare.create({ data: { sessionId: session.id,
                sharedByUserId: owner.id, sharedWithUserId: viewer.id, accessLevel: 'view' } });
            for (const account of [owner, viewer]) expect(await setAccountSessionFollow({ accountId: account.id,
                sessionId: source.id, preferences: { policy: { preset: 'quiet' } }, authentication })).toMatchObject({ ok: true });
            const input = { direction: 'followers' as const, source: { kind: 'session' as const, sessionId: source.id } };
            const request = resolveSessionFollowActionRequest('follow.list', input);
            const result = await viewerApp.inject({ method: request.method, url: request.path });
            expect(result.statusCode).toBe(200);
            const body = parseSessionFollowActionResponse('follow.list', input, result.json());
            expect(body.peopleCount).toBe(2);
            expect(body.follows).toHaveLength(1);
            expect(body.follows[0]).toMatchObject({ sessionId: source.id });
            expect(body.sources).toHaveLength(2);
            expect(body.sources.every(row => row.destinationSessionId === visible.id)).toBe(true);
            expect(body.sources.map(row => row.relation).sort()).toEqual(['follower', 'manager']);
            expect(body.rules).toEqual([]);
            const pageInput = { ...input, limit: 1 };
            const firstRequest = resolveSessionFollowActionRequest('follow.list', pageInput);
            const firstPage = parseSessionFollowActionResponse('follow.list', pageInput,
                (await viewerApp.inject({ method: firstRequest.method, url: firstRequest.path })).json());
            expect(firstPage.sources).toHaveLength(1);
            expect(firstPage).toMatchObject({ coverage: 'partial', continuation: expect.any(String), peopleCount: 2 });
            const nextInput = { ...pageInput, cursor: firstPage.continuation };
            const nextRequest = resolveSessionFollowActionRequest('follow.list', nextInput);
            const nextPage = parseSessionFollowActionResponse('follow.list', nextInput,
                (await viewerApp.inject({ method: nextRequest.method, url: nextRequest.path })).json());
            expect(nextPage.sources).toHaveLength(1);
            expect(nextPage.sources[0]?.relation).not.toBe(firstPage.sources[0]?.relation);
            expect(nextPage).toMatchObject({ coverage: 'complete', peopleCount: 2 });
            expect(nextPage.continuation).toBeUndefined();
            expect(JSON.stringify(body)).not.toContain(owner.id);
            expect(JSON.stringify(body)).not.toContain(viewer.id);
            const personal = { accountId: viewer.id, sessionId: source.id, authentication };
            expect(await removeAccountSessionFollow(personal)).toMatchObject({ ok: true });
            const unfollowed = await viewerApp.inject({ method: request.method, url: request.path });
            expect(unfollowed.statusCode).toBe(200);
            expect(parseSessionFollowActionResponse('follow.list', input, unfollowed.json()))
                .toMatchObject({ peopleCount: 1, follows: [] });
            expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: {
                accountId: viewer.id, sessionId: source.id,
            } } })).toMatchObject({ following: false, hasPersistentFollow: true });
            expect(await getAccountSessionFollow(personal)).toMatchObject({ ok: true, value: { follow: { following: false } } });
            expect(await setAccountSessionFollow({ ...personal, preferences: { policy: { preset: 'quiet' } } })).toMatchObject({ ok: true });
            await db.account.update({ where: { id: viewer.id }, data: { status: 'suspended' } });
            expect((await app.inject({ method: request.method, url: request.path })).json().peopleCount).toBe(1);
            await db.account.update({ where: { id: viewer.id }, data: { status: 'active' } });
            await db.sessionShare.deleteMany({ where: { sessionId: visible.id, sharedWithUserId: viewer.id } });
            expect(parseSessionFollowActionResponse('follow.list', input,
                (await viewerApp.inject({ method: request.method, url: request.path })).json()).sources).toEqual([]);
            expect((await viewerApp.inject({ method: nextRequest.method, url: nextRequest.path })).json())
                .toMatchObject({ sources: [], coverage: 'complete' });
            await db.sessionShare.deleteMany({ where: { sessionId: source.id, sharedWithUserId: viewer.id } });
            expect((await viewerApp.inject({ method: request.method, url: request.path })).json()).toEqual({ error: 'session_not_found' });
            const ownerBody = (await app.inject({ method: request.method, url: request.path })).json();
            expect(ownerBody.peopleCount).toBe(1);
            const empty = await createSession(owner.id);
            expect((await app.inject({ method: 'GET', url: `/v2/sessions/${empty.id}/follows/followers` })).json())
                .toEqual({ follows: [], sources: [], rules: [], coverage: 'complete', peopleCount: 0 });
        } finally { await app.close(); await viewerApp.close(); }
    });

    it('counts an armed personal one-shot but not its retained fulfilled-only witness', async () => {
        const owner = await createAccount();
        const viewer = await createAccount();
        const source = await createSession(owner.id, { latestTurnId: 'once-turn', latestTurnStatus: 'in_progress' });
        await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id,
            sharedWithUserId: viewer.id, accessLevel: 'view' } });
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const personal = { accountId: viewer.id, sessionId: source.id, authentication };
        expect(await setAccountSessionFollow({ ...personal,
            preferences: { once: { kind: 'turn_finished', sourceTurnId: 'once-turn' } } })).toMatchObject({ ok: true });
        const app = await buildApp(viewer.id);
        const input = { direction: 'followers' as const, source: { kind: 'session' as const, sessionId: source.id } };
        const request = resolveSessionFollowActionRequest('follow.list', input);
        try {
            const armed = parseSessionFollowActionResponse('follow.list', input,
                (await app.inject({ method: request.method, url: request.path })).json());
            expect(armed).toMatchObject({ peopleCount: 1, follows: [expect.objectContaining({ persistent: false,
                once: { kind: 'turn_finished', sourceTurnId: 'once-turn' } })] });
            const row = await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: {
                accountId: viewer.id, sessionId: source.id,
            } } });
            if (!row.notifyOnce) throw new Error('Expected armed one-shot');
            await db.sessionTurn.create({ data: { sessionId: source.id, turnId: 'once-turn', status: 'completed', startedAt: 1,
                updatedAt: 2, terminalAt: 2 } });
            expect(await acceptAccountSessionFollowOnceDelivery({ accountId: viewer.id, sessionId: source.id,
                expectedOnce: row.notifyOnce, occurrence: { event: 'ready', turnId: 'once-turn', agentStateVersion: 0 } })).toBe(true);
            expect(parseSessionFollowActionResponse('follow.list', input,
                (await app.inject({ method: request.method, url: request.path })).json())).toMatchObject({ peopleCount: 0, follows: [] });
            expect(await getAccountSessionFollow(personal)).toMatchObject({ ok: true, value: { follow: {
                persistent: false, once: null, onceDelivery: { event: 'ready', turnId: 'once-turn' },
            } } });
        } finally { await app.close(); }
    });

    it('discovers only current authorized ordinary and manager routes for one original source occurrence', async () => {
        const owner = await createAccount();
        const other = await createAccount();
        const fence = new Date(1_800_000_000_000);
        const source = await createSession(owner.id, { active: true, seq: 1, lastActiveAt: fence,
            publisherGeneration: 1n, publisherGenerationLastActiveAt: fence, agentStateVersion: 2 });
        const destination = await createSession(owner.id);
        const foreignDestination = await createSession(other.id);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            installationId: randomUUID(), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            metadata: encodePlainMachineStoredContent({}) } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: source.id, data: 'opaque' } });
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const app = await buildApp(owner.id);
        const foreignApp = await buildApp(other.id);
        const url = `/v2/sessions/${source.id}/follows/occurrence-routes`;
        const publisher = { machineId: machine.id, committedFenceMs: fence.getTime(), publisherGeneration: '1' };
        const payload = { v: 1, sourcePublisher: publisher, sourceMessage: { localId: 'original', seq: 2 } };
        try {
            expect((await app.inject({ method: 'PUT', url: `/v2/sessions/${destination.id}/follows/sessions/${source.id}`,
                payload: { policy: { preset: 'everything' } } })).statusCode).toBe(200);
            expect(await setSessionManager({ accountId: owner.id, sessionId: source.id,
                managerSessionId: destination.id, expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
            await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id,
                sharedWithUserId: other.id, accessLevel: 'view' } });
            await db.sessionShare.create({ data: { sessionId: foreignDestination.id, sharedByUserId: other.id,
                sharedWithUserId: owner.id, accessLevel: 'edit' } });
            expect((await foreignApp.inject({ method: 'PUT', url: `/v2/sessions/${foreignDestination.id}/follows/sessions/${source.id}`,
                payload: { policy: { preset: 'important' } } })).statusCode).toBe(200);
            expect(await setAccountSessionFollow({ accountId: other.id, sessionId: source.id,
                preferences: { policy: { preset: 'quiet' } }, authentication })).toMatchObject({ ok: true });
            await db.userKVStore.create({ data: { accountId: other.id, key: 'private-rule-definition',
                value: new TextEncoder().encode('private-rule-secret') } });
            const originalCreatedAt = fence.getTime() - 10;
            await db.sessionMessage.create({ data: { sessionId: source.id, seq: 2, localId: 'original', createdAt: new Date(originalCreatedAt),
                messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Original update' } } } } });
            await db.session.update({ where: { id: source.id }, data: { seq: 3 } });
            const edgesBefore = await db.sessionFollowEdge.findMany({ where: { sourceSessionId: source.id } });
            const result = await app.inject({ method: 'POST', url, payload });
            expect(result.statusCode).toBe(200);
            const body = result.json();
            expect(body.originalCreatedAt).toBe(originalCreatedAt);
            expect(Object.keys(body).sort()).toEqual(['currentAccountFacts', 'ok', 'originalCreatedAt', 'routes', 'sourceSessionId', 'v']);
            expect(body.currentAccountFacts).toEqual({ defaultRelationships: {
                assigned: false, direct: false, team: false, group: false,
            }, personalFollowSuppressed: false, hasPersistentFollow: false });
            expect(body).toMatchObject({ ok: true, v: 1, sourceSessionId: source.id });
            expect(body.routes).toHaveLength(3);
            expect(body.routes).toEqual(expect.arrayContaining([
                expect.objectContaining({ destinationSessionId: destination.id, relation: 'follower', policy: { preset: 'everything' } }),
                expect.objectContaining({ destinationSessionId: destination.id, relation: 'manager', attachedAt: expect.any(Number) }),
                expect.objectContaining({ destinationSessionId: foreignDestination.id, relation: 'follower', policy: { preset: 'important' } }),
            ]));
            expect(new Set(body.routes.map((route: { destinationSessionId: string; relation: string }) => `${route.destinationSessionId}:${route.relation}`)).size).toBe(3);
            expect(body.routes.every((route: { observed: { transcriptSeq: number }; delivered: { transcriptSeq: number } }) =>
                route.delivered.transcriptSeq === 1 && route.observed.transcriptSeq === 2)).toBe(true);
            expect(JSON.stringify(body)).not.toContain('private-rule');
            expect(body.routes.every((route: object) => !('rule' in route) && !('accountId' in route))).toBe(true);
            expect(await db.sessionFollowEdge.findMany({ where: { sourceSessionId: source.id } })).toEqual(edgesBefore);
            const receiverPayload = { v: 1, destinationSessionId: foreignDestination.id,
                sourceMessage: payload.sourceMessage };
            const receiverResult = await foreignApp.inject({ method: 'POST', url, payload: receiverPayload });
            expect(receiverResult.statusCode).toBe(200);
            expect(receiverResult.json().currentAccountFacts).toEqual({ defaultRelationships: {
                assigned: false, direct: true, team: false, group: false,
            }, personalFollowSuppressed: false, hasPersistentFollow: true });
            expect(receiverResult.json()).toMatchObject({ ok: true, originalCreatedAt, routes: [{ destinationSessionId: foreignDestination.id }] });
            expect(receiverResult.json().routes).toHaveLength(1);
            const ruleOnlyDestination = await createSession(other.id);
            expect((await foreignApp.inject({ method: 'POST', url,
                payload: { ...receiverPayload, destinationSessionId: ruleOnlyDestination.id } })).json())
                .toMatchObject({ ok: true, v: 1, sourceSessionId: source.id, routes: [] });
            expect((await foreignApp.inject({ method: 'POST', url,
                payload: { ...receiverPayload, destinationSessionId: destination.id } })).json())
                .toEqual({ ok: false, v: 1, error: 'forbidden' });
            expect((await foreignApp.inject({ method: 'POST', url,
                payload: { ...receiverPayload, sourcePublisher: publisher } })).json())
                .toEqual({ ok: false, v: 1, error: 'invalid_request' });
            // Receiver-owned recovery does not impersonate a foreign/offline publisher Machine.
            await db.session.update({ where: { id: source.id }, data: { active: false } });
            await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
            expect((await foreignApp.inject({ method: 'POST', url, payload: receiverPayload })).json())
                .toMatchObject({ ok: true, routes: [{ destinationSessionId: foreignDestination.id }] });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            await db.session.update({ where: { id: source.id }, data: { active: true } });
            await db.machine.update({ where: { id: machine.id }, data: { revokedAt: null } });
            await db.sessionShare.deleteMany({ where: { sessionId: source.id, sharedWithUserId: other.id } });
            expect((await foreignApp.inject({ method: 'POST', url, payload: receiverPayload })).json())
                .toEqual({ ok: false, v: 1, error: 'forbidden' });
            await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id,
                sharedWithUserId: other.id, accessLevel: 'view' } });
            const requests = { v: 1, sourcePublisher: publisher,
                sourceRequests: { agentStateVersion: 2, requests: [{ requestId: 'question', createdAt: fence.getTime() }] } };
            const requestRoutes = (await app.inject({ method: 'POST', url, payload: requests })).json();
            expect(requestRoutes).toMatchObject({ ok: true, originalCreatedAt: fence.getTime(), routes: [{ destinationSessionId: destination.id, relation: 'manager',
                delivered: { agentStateVersion: 1 }, observed: { agentStateVersion: 2 } }] });
            expect(requestRoutes.routes).toHaveLength(1);
            expect((await app.inject({ method: 'POST', url, payload: { ...requests,
                sourceRequests: { ...requests.sourceRequests, agentStateVersion: 1 } } })).json())
                .toEqual({ ok: false, v: 1, error: 'forbidden' });
            const mute = { accountId: owner.id, receiver: { kind: 'session', sessionId: destination.id } as const,
                scope: { kind: 'sender_session', sessionId: source.id } as const, authentication };
            expect(await changeDeliveryMute({ ...mute, operation: 'set' })).toMatchObject({ ok: true });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toMatchObject({ ok: true,
                routes: [{ destinationSessionId: foreignDestination.id }] });
            expect(await changeDeliveryMute({ ...mute, operation: 'remove' })).toMatchObject({ ok: true });
            for (const invalid of [
                { ...payload, sourcePublisher: { ...publisher, machineId: randomUUID() } },
                { ...payload, sourcePublisher: { ...publisher, publisherGeneration: '2' } },
                { ...payload, sourcePublisher: { ...publisher, committedFenceMs: publisher.committedFenceMs + 1 } },
                { ...payload, sourceMessage: { localId: 'original', seq: 3 } },
                { ...payload, sourceMessage: { localId: 'missing', seq: 2 } },
            ]) expect((await app.inject({ method: 'POST', url, payload: invalid })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            expect((await foreignApp.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            expect((await app.inject({ method: 'POST', url, payload: { ...payload, rules: [] } })).json())
                .toEqual({ ok: false, v: 1, error: 'invalid_request' });
            expect((await app.inject({ method: 'POST', url, payload, headers: { 'x-test-auth-token-kind': 'api_token' } })).statusCode).toBe(403);
            // A retained relation never replaces current caller or pairwise disclosure authority.
            await db.sessionShare.deleteMany({ where: { sessionId: foreignDestination.id } });
            const revoked = (await app.inject({ method: 'POST', url, payload })).json();
            expect(revoked.routes).toHaveLength(2);
            expect(revoked.routes.every((route: { destinationSessionId: string }) => route.destinationSessionId === destination.id)).toBe(true);
            await db.session.update({ where: { id: destination.id }, data: { archivedAt: new Date() } });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toMatchObject({ ok: true, routes: [] });
            await db.session.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
        } finally { await app.close(); await foreignApp.close(); }
    });

    it('observes pending follower and manager relations without a publisher only at the exact committed own machine', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, { seq: 1 });
        const worker = await createSession(owner.id, { seq: 1 });
        await createSession(owner.id, { seq: 99 });
        const destination = await createSession(owner.id, { active: false });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), metadata: encodePlainMachineStoredContent({}),
        } });
        const target = { homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: owner.id,
            sessionId: destination.id, machineId: machine.id, installationId: machine.installationId! };
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: destination.id, data: 'opaque' } });
        await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: target } });
        const app = await buildApp(owner.id);
        try {
            expect((await app.inject({ method: 'PUT', url: `/v2/sessions/${destination.id}/follows/sessions/${source.id}`,
                payload: { policy: { preset: 'important' } } })).statusCode).toBe(200);
            await db.sessionFollowEdge.create({ data: { sourceSessionId: worker.id, destinationSessionId: destination.id,
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: worker.id }),
                policyJson: JSON.stringify({ preset: 'important' }),
                relation: 'manager', managerSourceSessionId: worker.id } });
            await db.session.updateMany({ where: { id: { in: [source.id, worker.id] } }, data: { seq: 2 } });
            const url = `/v2/sessions/${destination.id}/follows/inactive-observations`;
            const payload = { v: 1, machineId: machine.id, installationId: machine.installationId };
            const beforeRead = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
            const result = await app.inject({ method: 'POST', url, payload });
            expect(result.statusCode).toBe(200);
            expect(result.json()).toMatchObject({ ok: true, v: 1, sessionId: destination.id, target,
                currentSourceSessionIds: expect.arrayContaining([source.id, worker.id]) });
            expect(result.json().observations).toHaveLength(2);
            expect(result.json().observations.every((observation: { policy?: unknown }) =>
                JSON.stringify(observation.policy) === JSON.stringify({ preset: 'important' }))).toBe(true);
            expect(SessionFollowObserveInactiveResponseV1Schema.safeParse(result.json()).success).toBe(true);
            expect((await db.sessionFollowEdge.findFirstOrThrow({ where: { sourceSessionId: source.id, relation: 'follower' } })).deliveredTranscriptSeq).toBe(1);
            expect((await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: worker.id } })).deliveredTranscriptSeq).toBe(0);
            expect(await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } })).toEqual(beforeRead);
            // Host loss can leave this projection true across a daemon restart;
            // the daemon's canonical process census decides whether to spawn.
            await db.session.update({ where: { id: destination.id }, data: { active: true } });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toMatchObject({ ok: true, target });
            await db.session.update({ where: { id: destination.id }, data: { active: false } });
            for (const invalid of [{ ...payload, machineId: randomUUID() }, { ...payload, installationId: randomUUID() }]) {
                expect((await app.inject({ method: 'POST', url, payload: invalid })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            }
            const restricted = await app.inject({ method: 'POST', url, payload, headers: { 'x-test-auth-token-kind': 'api_token' } });
            expect(restricted.statusCode).toBe(403);
            expect((await app.inject({ method: 'POST', url, payload,
                headers: { 'x-test-auth-token-kind': 'terminal' } })).json()).toMatchObject({ ok: true, target });
            expect((await app.inject({ method: 'POST', url, payload: { ...payload, target } })).json())
                .toEqual({ ok: false, v: 1, error: 'invalid_request' });
            // A destination audience change is re-admitted on each read; the
            // retained edge does not authorize disclosing a private source.
            const viewer = await createAccount();
            await db.sessionShare.create({ data: { sessionId: destination.id, sharedByUserId: owner.id,
                sharedWithUserId: viewer.id, accessLevel: 'admin' } });
            const deniedSources = await app.inject({ method: 'POST', url, payload });
            expect(deniedSources.json()).toMatchObject({ ok: true, currentSourceSessionIds: [], observations: [] });
            const sharedAdminApp = await buildApp(viewer.id);
            try {
                expect((await sharedAdminApp.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            } finally { await sharedAdminApp.close(); }
            await db.sessionShare.deleteMany({ where: { sessionId: destination.id } });
            // Retained placement cannot borrow an uncommitted key tuple, nor
            // follow the same Machine id onto its replacement installation.
            await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: null } });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: target } });
            await db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            await db.machine.update({ where: { id: machine.id }, data: { installationId: target.installationId } });
            await db.session.update({ where: { id: destination.id }, data: { archivedAt: new Date() } });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
        } finally { await app.close(); }
    });

    it('exposes only the nested authoring resource and maps the closed failure vocabulary', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, { seq: 7, latestTurnId: 'turn-a', latestTurnStatus: 'completed' });
        const destination = await createSession(owner.id);
        const archived = await createSession(owner.id, { archivedAt: new Date() });
        const app = await buildApp(owner.id);

        const base = `/v2/sessions/${destination.id}/follows/sessions`;

        expect((await app.inject({ method: 'GET', url: base })).json()).toEqual({ sources: [] });

        const created = await app.inject({ method: 'PUT', url: `${base}/${source.id}`, payload: { policy: { preset: 'important' } } });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toEqual({
            changed: true,
            source: {
                sourceSessionId: source.id,
                destinationSessionId: destination.id,
                policy: { preset: 'important' as const },
                deliveryState: 'eligible',
                hasPendingUpdates: false,
            },
        });

        const listed = await app.inject({ method: 'GET', url: base });
        expect(listed.json()).toEqual({ sources: [{
            sourceSessionId: source.id,
            destinationSessionId: destination.id,
            policy: { preset: 'important' as const },
            deliveryState: 'eligible',
            hasPendingUpdates: false,
        }] });

        // Same Session, unknown Session and an archived endpoint each map to
        // their exact code without leaking existence.
        const same = await app.inject({ method: 'PUT', url: `${base}/${destination.id}`, payload: { policy: { preset: 'important' } } });
        expect([same.statusCode, same.json().error]).toEqual([400, 'session_follow_same_session']);

        const unknown = await app.inject({ method: 'PUT', url: `${base}/missing-session`, payload: { policy: { preset: 'important' } } });
        expect([unknown.statusCode, unknown.json().error]).toEqual([404, 'session_not_found']);

        const archivedResponse = await app.inject({
            method: 'PUT',
            url: `/v2/sessions/${archived.id}/follows/sessions/${source.id}`,
            payload: { policy: { preset: 'important' } },
        });
        expect([archivedResponse.statusCode, archivedResponse.json().error]).toEqual([409, 'session_archived']);

        // The strict source writer preserves its explicit shared policy and
        // refuses missing policy, retired mode and unknown fields.
        const explicitMode = await app.inject({ method: 'PUT', url: `${base}/${source.id}`, payload: { policy: { preset: 'important' as const } } });
        expect(explicitMode.statusCode).toBe(200);
        expect(explicitMode.json()).toEqual({
            changed: false,
            source: {
                sourceSessionId: source.id,
                destinationSessionId: destination.id,
                policy: { preset: 'important' as const },
                deliveryState: 'eligible',
                hasPendingUpdates: false,
            },
        });

        const invalidMode = await app.inject({ method: 'PUT', url: `${base}/${source.id}`, payload: { mode: 'always' } });
        expect([invalidMode.statusCode, invalidMode.json()]).toEqual([400, { error: 'invalid_parameters' }]);
        const missingPolicy = await app.inject({ method: 'PUT', url: `${base}/${source.id}`, payload: {} });
        expect([missingPolicy.statusCode, missingPolicy.json()]).toEqual([400, { error: 'invalid_parameters' }]);

        const unexpectedField = await app.inject({ method: 'PUT', url: `${base}/${source.id}`, payload: { executionAccountId: 'other' } });
        expect([unexpectedField.statusCode, unexpectedField.json()]).toEqual([400, { error: 'invalid_parameters' }]);

        // Removal is idempotent and there is no delivery surface to reach.
        expect((await app.inject({ method: 'DELETE', url: `${base}/${source.id}` })).json()).toEqual({ changed: true });
        expect((await app.inject({ method: 'DELETE', url: `${base}/${source.id}` })).json()).toEqual({ changed: false });
        expect((await app.inject({ method: 'POST', url: `${base}/${source.id}/wake` })).statusCode).toBe(404);

        await app.close();
    });

    it('conceals an inaccessible destination and refuses a caller without destination input authority', async () => {
        const owner = await createAccount();
        const viewer = await createAccount();
        const stranger = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        await db.sessionShare.create({
            data: {
                session: { connect: { id: destination.id } },
                sharedByUser: { connect: { id: owner.id } },
                sharedWithUser: { connect: { id: viewer.id } },
                accessLevel: 'view',
            },
        });
        await db.sessionShare.create({
            data: {
                session: { connect: { id: source.id } },
                sharedByUser: { connect: { id: owner.id } },
                sharedWithUser: { connect: { id: viewer.id } },
                accessLevel: 'view',
            },
        });

        const base = `/v2/sessions/${destination.id}/follows/sessions`;

        const strangerApp = await buildApp(stranger.id);
        const concealed = await strangerApp.inject({ method: 'GET', url: base });
        expect([concealed.statusCode, concealed.json().error]).toEqual([404, 'session_not_found']);
        await strangerApp.close();

        const viewerApp = await buildApp(viewer.id);
        const forbidden = await viewerApp.inject({ method: 'PUT', url: `${base}/${source.id}`, payload: { policy: { preset: 'important' } } });
        expect([forbidden.statusCode, forbidden.json().error]).toEqual([403, 'session_follow_source_forbidden']);
        await viewerApp.close();
    });

    it('refuses an exhausted public destination while its issued message token can still read, then admits after expiry', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        const token = randomUUID();
        const tokenHash = createHash('sha256').update(token, 'utf8').digest();
        const publication = await db.publicSessionShare.create({ data: {
            sessionId: destination.id,
            createdByUserId: owner.id,
            tokenHash,
            maxUses: 1,
            useCount: 1,
            isConsentRequired: false,
            expiresAt: new Date(Date.now() + 60_000),
        } });
        const messagesAccessToken = createPublicShareMessagesAccessToken({
            secret: requirePublicShareAccessGrantSecret(),
            publicShareId: publication.id,
            sessionId: destination.id,
            tokenHashHex: tokenHash.toString('hex'),
        });
        const app = await buildApp(owner.id);
        try {
            const readPublicMessages = () => app.inject({
                method: 'GET',
                url: `/v1/public-share/${token}/messages`,
                headers: { [PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER]: messagesAccessToken },
            });
            expect((await readPublicMessages()).statusCode).toBe(200);

            const setSource = () => app.inject({
                method: 'PUT',
                url: `/v2/sessions/${destination.id}/follows/sessions/${source.id}`,
                payload: { policy: { preset: 'important' } },
            });
            const denied = await setSource();
            expect([denied.statusCode, denied.json()]).toEqual([403, { error: 'session_follow_source_forbidden' }]);
            expect(await db.sessionFollowEdge.count()).toBe(0);

            await db.publicSessionShare.update({ where: { id: publication.id }, data: { expiresAt: new Date(0) } });
            expect((await readPublicMessages()).statusCode).toBe(404);
            expect((await setSource()).statusCode).toBe(200);
        } finally {
            await app.close();
        }
    });
});
