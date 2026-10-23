import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';

import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { resolveEffectiveMachineAccessForMachinesInTx, resolveEffectiveMachineRoleInTx } from './machineAccess';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Machine bulk permission SQL (PostgreSQL)', () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'>;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run only through the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event));
        await client.$connect();
    });
    afterAll(async () => { await client?.$disconnect(); await db.$disconnect(); });

    it('set-reads only permission facts and preserves singular roles across current and withdrawn grants', async () => {
        const people = await Promise.all(Array.from({ length: 9 }, () => db.account.create({ data: { encryptionMode: 'plain' } })));
        const [owner, otherOwner, direct, administrator, member, groupMember, removed, inactive, outsider] = people;
        await db.account.update({ where: { id: inactive!.id }, data: { status: 'suspended' } });
        const team = await db.team.create({ data: { name: 'Machine permission team' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Machine permission group', nameKey: 'machine-permission-group' } });
        const memberships = await Promise.all([member!, groupMember!, removed!].map(person => db.teamMembership.create({
            data: { teamId: team.id, accountId: person.id, role: 'member' },
        })));
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: memberships[1]!.id, nativeContribution: true } });
        await db.teamMembership.update({ where: { id: memberships[2]!.id }, data: { status: 'suspended' } });
        const machines = await Promise.all([owner!, otherOwner!, owner!].map((person, index) => db.machine.create({ data: {
            id: randomUUID(), accountId: person.id, metadata: 'unneeded-owner-metadata'.repeat(1000),
            daemonState: 'unneeded-daemon-state'.repeat(1000), revokedAt: index === 2 ? new Date() : null,
        } })));
        await db.machineAccountGrant.createMany({ data: machines.flatMap(machine => [
            { machineId: machine.id, accountId: direct!.id, accessLevel: 'view' as const, createdByAccountId: owner!.id },
            { machineId: machine.id, accountId: administrator!.id, accessLevel: 'admin' as const, createdByAccountId: owner!.id },
            { machineId: machine.id, accountId: inactive!.id, accessLevel: 'admin' as const, createdByAccountId: owner!.id },
        ]) });
        await db.machineTeamGrant.createMany({ data: machines.map(machine => ({
            machineId: machine.id, teamId: team.id, accessLevel: 'view', createdByAccountId: owner!.id,
        })) });
        await db.machineGroupGrant.createMany({ data: machines.map(machine => ({
            machineId: machine.id, teamGroupId: group.id, accessLevel: 'admin', createdByAccountId: owner!.id,
        })) });
        const missing = randomUUID();
        const machineIds = [...machines.map(machine => machine.id), machines[0]!.id, missing];
        const accountIds = people.map(person => person.id);
        const originalTransaction = db.$transaction;
        // Observe engine-emitted SQL at the real database transport; retain inTx
        // budgets and every internal authorization/membership calculation.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        try {
            const measure = async (ids: readonly string[]) => {
                statements.length = 0;
                const roles = await inTx(tx => resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds: ids, accountIds }));
                const selects = statements.filter(event => /^SELECT\b/i.test(event.query));
                const machineReads = selects.filter(event => /FROM "(?:public"\.")?Machine"(?:\s|$)/.test(event.query));
                return { roles, selects, machineReads };
            };
            const one = await measure([machines[0]!.id]);
            const many = await measure(machineIds);
            expect([...many.roles.keys()]).toEqual([...new Set(machineIds)]);
            for (const machineId of new Set(machineIds)) for (const actorAccountId of accountIds) {
                const singular = await inTx(tx => resolveEffectiveMachineRoleInTx(tx, { machineId, actorAccountId }));
                expect(many.roles.get(machineId)?.get(actorAccountId)).toBe(singular);
            }
            const roles = many.roles.get(machines[0]!.id)!;
            expect(roles.get(owner!.id)).toBe('manage');
            expect(roles.get(direct!.id)).toBe('use');
            expect(roles.get(administrator!.id)).toBe('manage');
            expect(roles.get(member!.id)).toBe('use');
            expect(roles.get(groupMember!.id)).toBe('manage');
            for (const person of [otherOwner!, removed!, inactive!, outsider!]) expect(roles.get(person.id)).toBeNull();
            expect([...many.roles.get(missing)!.values()].every(role => role === null)).toBe(true);
            // Revocation is a separate admission fact, not a new role rule.
            expect(many.roles.get(machines[2]!.id)?.get(owner!.id)).toBe('manage');
            const contentColumns = ['metadata', 'metadataVersion', 'daemonState', 'daemonStateVersion', 'dataEncryptionKey'];
            const selectedContentColumns = contentColumns.filter(column => many.selects.some(event => event.query.includes(`"${column}"`)));
            expect.soft(many.machineReads).toHaveLength(1);
            expect.soft(many.selects.length).toBe(one.selects.length);
            expect.soft(selectedContentColumns).toEqual([]);

            await db.machineAccountGrant.deleteMany({ where: { machineId: { in: machines.map(machine => machine.id) }, accountId: direct!.id } });
            await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
            await db.teamMembership.update({ where: { id: memberships[0]!.id }, data: { status: 'suspended' } });
            const withdrawn = await measure(machineIds);
            for (const machineId of machines.map(machine => machine.id)) {
                expect(withdrawn.roles.get(machineId)?.get(direct!.id)).toBeNull();
                expect(withdrawn.roles.get(machineId)?.get(member!.id)).toBeNull();
                // Group admin was withdrawn; its still-active Team membership remains Use.
                expect(withdrawn.roles.get(machineId)?.get(groupMember!.id)).toBe('use');
            }
            await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
            await db.account.update({ where: { id: owner!.id }, data: { status: 'suspended' } });
            await db.machine.update({ where: { id: machines[1]!.id }, data: { kind: 'ephemeral_session_runner' } });
            const restricted = await measure(machineIds);
            for (const machineId of new Set(machineIds)) for (const actorAccountId of accountIds) {
                expect(restricted.roles.get(machineId)?.get(actorAccountId)).toBe(
                    await inTx(tx => resolveEffectiveMachineRoleInTx(tx, { machineId, actorAccountId })),
                );
            }
            expect(restricted.roles.get(machines[0]!.id)?.get(owner!.id)).toBeNull();
            expect(restricted.roles.get(machines[0]!.id)?.get(groupMember!.id)).toBeNull();
            expect(restricted.roles.get(machines[0]!.id)?.get(administrator!.id)).toBe('manage');
            expect(restricted.roles.get(machines[1]!.id)?.get(administrator!.id)).toBeNull();
            expect(restricted.roles.get(machines[1]!.id)?.get(otherOwner!.id)).toBe('manage');
            statements.length = 0;
            expect(await inTx(tx => resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds: [], accountIds }))).toEqual(new Map());
            expect(statements.filter(event => /^SELECT\b/i.test(event.query))).toEqual([]);
        } finally { db.$transaction = originalTransaction; }
    });
});
