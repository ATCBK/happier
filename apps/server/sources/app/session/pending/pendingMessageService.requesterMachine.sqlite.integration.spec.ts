import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema,
    SessionPendingEnqueueByMachineResponseV1Schema } from '@happier-dev/protocol';

import { auth } from '@/app/auth/auth';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { createFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { setMachineAccessGrantInTx, removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('requester Session input through the custodian Machine socket', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-requester-machine-input-', initAuth: true });
        await getOrCreateServerIdentityId();
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('admits the hosted requester tuple, refuses another source Machine, and rechecks grant loss', async () => {
        const requester = await db.account.create({ data: { publicKey: `requester-${randomUUID()}` } });
        const custodian = await db.account.create({ data: { publicKey: `custodian-${randomUUID()}`, encryptionMode: 'plain' } });
        const createMachine = () => db.machine.create({ data: {
            id: randomUUID(), accountId: custodian.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const target = await createMachine();
        const wrongSource = await createMachine();
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: target.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
        const session = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(), metadata: 'encrypted' } });
        await db.accessKey.create({ data: { accountId: requester.id, machineId: target.id, sessionId: session.id, data: 'encrypted' } });
        const token = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
        // Only Socket.IO is substituted. Authentication, C41 grants, exact
        // AccessKey binding, Pending admission and durable SQLite writes are real.
        const enqueue = async (source: typeof target, localId: string) => {
            const socket = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: source.id,
                [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: source.installationId } }), { handshake: { auth: { token } } });
            machineUpdateHandler(custodian.id, socket as unknown as Socket, { operationSocketBatchLimits: {
                ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            } });
            const request = SessionPendingEnqueueByMachineRequestV1Schema.parse({ v: 1, sessionId: session.id,
                targetMachineId: target.id, localId, content: { t: 'encrypted', c: 'protected-requester-input' },
                requestedAction: { v: 1, kind: 'enqueue' }, requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) } });
            let response: unknown;
            await getSocketHandler(socket, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1)(request, (value: unknown) => { response = value; });
            return SessionPendingEnqueueByMachineResponseV1Schema.parse(response).result;
        };
        expect(await enqueue(target, 'hosted-input')).toEqual({ status: 'accepted', localId: 'hosted-input' });
        expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: {
            sessionId_localId: { sessionId: session.id, localId: 'hosted-input' } },
            select: { authorAccountId: true, content: true, inputAdmissionReceipt: true } })).toMatchObject({
            authorAccountId: null, content: { t: 'encrypted', c: 'protected-requester-input' },
            inputAdmissionReceipt: { issuer: 'authenticatedMachine', admittedTarget: {
                accountId: requester.id, machineId: target.id, sessionId: session.id, installationId: target.installationId } },
        });
        expect(await enqueue(target, 'hosted-input')).toEqual({ status: 'alreadyAccepted', localId: 'hosted-input' });
        expect(await enqueue(wrongSource, 'wrong-source')).toMatchObject({ status: 'rejected' });
        expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: target.id,
            principal: { kind: 'account', accountId: requester.id } }))).toMatchObject({ kind: 'removed' });
        expect(await enqueue(target, 'revoked-input')).toMatchObject({ status: 'rejected' });
        expect(await enqueue(target, 'hosted-input')).toMatchObject({ status: 'rejected' });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(1);
    });
});
