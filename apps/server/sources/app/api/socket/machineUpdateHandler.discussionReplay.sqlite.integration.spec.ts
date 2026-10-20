import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISCUSSION_AGENT_POST_EVENT_V1, DiscussionAgentPostResponseV1Schema, DiscussionAgentApprovedReplayResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { auth } from '@/app/auth/auth';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from 'privacy-kit';
import { inTx } from '@/storage/inTx';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createDiscussion } from '@/app/discussions/mutations';
import { inviteDiscussionParticipant, removeDiscussionParticipant, setDiscussionParticipantPolicy } from '@/app/discussions/accessService';
import { machineUpdateHandler } from './machineUpdateHandler';
import { sessionUpdateHandler } from './sessionUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from './machineSocketInstallationProof';

const authentication = createPresentUserSessionAccessAuthentication();
const options = { operationSocketBatchLimits: { ok: true as const, limits: { maxItems: 200, maxSerializedBytes: 524_288 } } };
const content = (text: string) => ({ t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text }] } });

describe('installed Machine reviewed Discussion publication (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussion-machine-replay-',
        initAuth: true, initEncrypt: false, initFiles: false, env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1',
            HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['drafts_for_approval', 'when_addressed'] as const)('publishes one reviewed %s reply without a receiver process and rechecks its original authority', async answerPolicy => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: owner.id, machineId: machine.id }))).toMatchObject({ kind: 'admitted' });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}', active: false } });
        const sourceInputId = randomUUID();
        const turnId = randomUUID();
        await db.sessionMessage.create({ data: { sessionId: session.id, localId: sourceInputId, seq: 1, messageRole: 'user', content: content('Question input') } });
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId, status: 'completed', startedAt: 1n, updatedAt: 2n,
            transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 1, userMessageSeqs: [1] }) } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'opaque' } });
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request: { creationLocalId: randomUUID(),
            titleContent: { t: 'plain', v: { v: 1, title: 'Reviewed reply' } }, firstMessage: { localId: randomUUID(),
                content: content('The original question'), mentionedAccountIds: [] } } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await inviteDiscussionParticipant({ actorAccountId: owner.id, authentication, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy } })).toMatchObject({ ok: true });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        // Network boundary starts after the normal handshake has verified the
        // installation proof. Auth, Machine custody, resource policy and SQLite are real.
        const socket = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
            authAuthority: 'present_user', [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } }),
            { handshake: { auth: { token } } });
        // Socket.IO retains all listeners, unlike the basic testkit's handler
        // lookup. Preserve that network behavior when composing startup's two
        // actual registrars so a rejecting first ACK cannot mask a later commit.
        const events = new EventEmitter();
        const register = socket.on;
        socket.on = (event, listener) => {
            events.on(event, listener);
            register(event, (...args: unknown[]) => Promise.all(events.listeners(event).map(handler => Reflect.apply(handler, socket, args))));
        };
        sessionUpdateHandler(owner.id, socket as never, { connectionType: 'machine-scoped', userId: owner.id, machineId: machine.id, socket } as never);
        machineUpdateHandler(owner.id, socket as never, options);
        const publication = { v: 1 as const, sessionId: session.id, discussionId,
            sourceSession: { sourceSessionId: session.id, sourceInputId, sourceTurnId: turnId, via: 'action' as const },
            request: { localId: `approved-${randomUUID()}`, content: content('The exact privately reviewed answer'),
                mentionedAccountIds: [], replyTarget: { kind: 'message' as const, messageId: created.value.firstMessage.id } },
            draftReview: { artifactId: randomUUID(), decidingAccountId: owner.id } };
        const packet = { v: 1, operation: 'approved_replay', machineId: machine.id, publication };
        const publishRaw = async (value: unknown = packet) => {
            const acknowledgements: unknown[] = [];
            await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)(value, (response: unknown) => { acknowledgements.push(response); });
            expect(acknowledgements).toHaveLength(1);
            return acknowledgements[0];
        };
        const publish = async (value: unknown = packet) => DiscussionAgentPostResponseV1Schema.parse(await publishRaw(value));
        const first = await publish();
        if (!first.ok) throw new Error(`Reviewed Machine publication refused: ${first.error}`);
        expect(first).toMatchObject({ ok: true, value: { message: { authorAccountId: owner.id,
            producerV1: { v: 1, kind: 'agent', sessionId: session.id }, content: publication.request.content } } });
        expect(await publish()).toEqual(first); // Lost-ACK retry is the same writer/equality identity.
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ active: false, publisherGeneration: 0n });
        expect(socket.handlers.has(`${session.id}:discussion.agentPost.v1`)).toBe(false);
        const sessionSocket = createFakeSocket({ data: { clientType: 'session-scoped', sessionId: session.id, authAuthority: 'present_user' } });
        const sessionEvents = new EventEmitter();
        sessionSocket.on = (event, listener) => { sessionEvents.on(event, listener); };
        sessionUpdateHandler(owner.id, sessionSocket as never, { connectionType: 'session-scoped', userId: owner.id, sessionId: session.id, socket: sessionSocket } as never);
        machineUpdateHandler(owner.id, sessionSocket as never, options);
        const sessionAcks: unknown[] = [];
        await Promise.all(sessionEvents.listeners(DISCUSSION_AGENT_POST_EVENT_V1).map(listener => Reflect.apply(listener, sessionSocket,
            [publication, (ack: unknown) => { sessionAcks.push(ack); }])));
        // The ordinary Session listener must remain the sole owner and retain
        // its actual current-publisher refusal; Machine replay cannot replace it.
        expect(sessionAcks).toEqual([{ v: 1, ok: false, error: 'discussion_post_denied' }]);
        // SQLite itself refuses this insert. The socket owner must acknowledge
        // uncertainty rather than leave an otherwise healthy caller pending.
        await db.$executeRawUnsafe('CREATE TRIGGER "reviewed_post_boundary_failure" BEFORE INSERT ON "DiscussionMessage" WHEN NEW."localId" = \'db-boundary-failure\' BEGIN SELECT RAISE(ABORT, \'reviewed-post-storage-failure\'); END');
        try {
            expect(DiscussionAgentApprovedReplayResponseV1Schema.parse(await publishRaw({ ...packet, publication: { ...publication,
                request: { ...publication.request, localId: 'db-boundary-failure' } } }))).toEqual({ v: 1, ok: false, error: 'outcome_unknown' });
            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
        } finally { await db.$executeRawUnsafe('DROP TRIGGER "reviewed_post_boundary_failure"'); }
        expect(await publish({ ...packet, publication: { ...publication, sourceSession: undefined } }))
            .toMatchObject({ ok: false, error: 'discussion_invalid_content' });
        expect(await publish({ ...packet, publication: { ...publication, sourceSession: undefined,
            replyReturn: { serverId: 'home', requestLocalId: 'not-an-admitted-original' } } }))
            .toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await publish(publication)).toMatchObject({ ok: false }); // No raw draft/Agent publication on a Machine socket.
        expect(await publish({ ...packet, publication: { ...publication, draftReview: undefined } })).toMatchObject({ ok: false });
        expect(await publish({ ...packet, machineId: randomUUID() })).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await publish({ ...packet, publication: { ...publication,
            sourceSession: { ...publication.sourceSession, sourceInputId: 'not-in-that-turn' } } })).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        expect(await publish({ ...packet, publication: { ...publication,
            draftReview: { ...publication.draftReview, decidingAccountId: outsider.id } } })).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        const boundMachine = socket.data!.machineId;
        const otherMachine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        socket.data!.machineId = otherMachine.id;
        socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] = otherMachine.installationId;
        expect(await publish({ ...packet, machineId: otherMachine.id })).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        socket.data!.machineId = boundMachine;
        socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] = machine.installationId;
        const installation = socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY];
        socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] = randomUUID();
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] = installation;
        socket.data!.clientType = 'user-scoped';
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        socket.data!.clientType = 'machine-scoped';
        socket.handshake.auth.token = 'not-a-current-credential';
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        socket.handshake.auth.token = token;
        await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        await db.machine.update({ where: { id: machine.id }, data: { revokedAt: null } });
        await db.session.update({ where: { id: session.id }, data: { archivedAt: new Date() } });
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        await db.session.update({ where: { id: session.id }, data: { archivedAt: null } });
        await db.accessKey.delete({ where: { accountId_machineId_sessionId: { accountId: owner.id, machineId: machine.id, sessionId: session.id } } });
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'opaque' } });
        const newPacket = () => ({ ...packet, publication: { ...publication, request: { ...publication.request, localId: randomUUID() } } });
        expect(await setDiscussionParticipantPolicy({ actorAccountId: owner.id, authentication, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'reads_only' } })).toMatchObject({ ok: true });
        expect(await publish(newPacket())).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await removeDiscussionParticipant({ actorAccountId: owner.id, authentication, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        expect(await publish(newPacket())).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
    });
});
