import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeSessionTeamCredentialSlotKeyV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { deleteOwnedSession } from '@/app/session/delete/deleteOwnedSession';
import { TEAM_CHANGE_ENTITY_ID, publishTeamChangedInTx } from '@/app/teams/teamChanges';
import { prepareSessionAccountCursorLocks } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { transitionSessionArchiveStateInTx } from '@/app/session/archive/transitionSessionArchiveStateInTx';
import { admitProviderBrokerConsumerInTx } from './brokerConsumerAdmission';

describe('Home broker consumer PostgreSQL publication contract', () => {
    const prefix = `broker-consumer-${crypto.randomUUID()}`;
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) throw new Error('Use the disposable PostgreSQL DB-contract harness');
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => {
        if (!connected) return;
        await db.team.deleteMany({ where: { name: prefix } });
        await db.session.deleteMany({ where: { account: { publicKey: { startsWith: prefix } } } });
        await db.machine.deleteMany({ where: { account: { publicKey: { startsWith: prefix } } } });
        await db.account.deleteMany({ where: { publicKey: { startsWith: prefix } } });
        await db.$disconnect();
    });

    it('publishes only the exact custodians through real deletion and Team audience expansion', async () => {
        const [owner, custodian, stranger] = await Promise.all(Array.from({ length: 3 }, (_, index) =>
            db.account.create({ data: { publicKey: `${prefix}-${index}`, encryptionMode: 'plain' } })));
        const team = await db.team.create({ data: { name: prefix } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id, metadata: '{}' } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: 'Brokered',
            disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}',
            brokerMachineId: machine.id,
        } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: prefix,
            encryptionMode: 'plain', metadata: '{}', active: true } });
        await db.sessionTeamCredentialBinding.create({ data: { sessionId: session.id, slotKind: 'provider_model:brokered',
            slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: 'provider_model' })),
            resourceId: resource.id, resourceRevision: resource.revision } });

        // Exercise the HTTP archive composition's outer admission, not only a
        // nested writer that could discover a new custodian too late.
        await inTx(tx => transitionSessionArchiveStateInTx({ tx, sessionId: session.id,
            wasArchived: false, archivedAt: new Date() }), {
            prepare: () => prepareSessionAccountCursorLocks([session.id], [owner.id], { includeLifecyclePublications: true }),
        });
        expect(await inTx(tx => admitProviderBrokerConsumerInTx(tx, {
            accountId: owner.id, initiatorMachineId: machine.id, consumer: { kind: 'session', sessionId: session.id }, executionRun: null,
        }))).toEqual({ ok: false, reasonCode: 'session_not_active' });
        // Caller-initiated deletion also requires the publisher's stop.
        await db.session.update({ where: { id: session.id }, data: { active: false } });

        expect(await deleteOwnedSession({ sessionId: session.id, ownerAccountId: owner.id, reason: 'user_request' }))
            .toEqual({ ok: true });
        const changes = await db.accountChange.findMany({ where: { accountId: { in: [owner.id, custodian.id, stranger.id] },
            kind: 'account', entityId: TEAM_CHANGE_ENTITY_ID }, orderBy: { accountId: 'asc' },
            select: { accountId: true, hint: true } });
        expect(changes).toEqual([owner.id, custodian.id].sort().map(accountId => ({ accountId, hint: null })));
        const before = (await db.account.findUniqueOrThrow({ where: { id: custodian.id }, select: { seq: true } })).seq;
        await inTx(tx => publishTeamChangedInTx(tx, { teamId: team.id }));
        expect((await db.account.findUniqueOrThrow({ where: { id: custodian.id }, select: { seq: true } })).seq).toBe(before + 1);
        expect(await db.accountChange.count({ where: { accountId: stranger.id } })).toBe(0);
    });
});
