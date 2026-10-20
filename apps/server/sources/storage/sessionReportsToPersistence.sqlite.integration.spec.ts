import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('SessionReportsTo persistence', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-reports-to-persistence-' });
    }, 180_000);

    afterAll(async () => {
        await harness?.close();
    });

    it('preserves the Follow frontier and makes children roots when either endpoint is deleted', async () => {
        const account = await db.account.create({ data: { publicKey: `reports-to-${randomUUID()}` } });
        const createSession = () => db.session.create({
            data: { accountId: account.id, tag: randomUUID(), metadata: '{}' },
        });
        const [child, lead, deletedChild, survivingLead] = await Promise.all([
            createSession(), createSession(), createSession(), createSession(),
        ]);
        const attachedAt = new Date('2026-09-30T12:00:00.000Z');
        // Raw SQL exercises the migration itself, including before a generated
        // Prisma client can expose the newly introduced model.
        await db.$executeRaw`
            INSERT INTO "SessionFollowEdge" (
                "sourceKey", "sourceSessionId", "destinationSessionId", "relation", "managerSourceSessionId", "attachedAt", "policyJson", "deliveredTranscriptSeq",
                "deliveredReadyEventSeq", "deliveredAgentStateVersion", "deliveredTurnId", "deliveredTurnStatus"
            ) VALUES (${sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: child.id })}, ${child.id}, ${lead.id}, 'manager', ${child.id}, ${attachedAt}, '{"preset":"important"}', 7, 3, 2, 'turn-report', 'completed')
        `;
        await db.$executeRaw`
            INSERT INTO "SessionFollowEdge" ("sourceKey", "sourceSessionId", "destinationSessionId", "relation", "managerSourceSessionId", "attachedAt", "policyJson")
            VALUES (${sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: deletedChild.id })}, ${deletedChild.id}, ${survivingLead.id}, 'manager', ${deletedChild.id}, ${attachedAt}, '{"preset":"important"}')
        `;
        const rows = await db.$queryRaw<Array<{
            sessionId: string;
            leadSessionId: string;
            attachedAt: Date;
            deliveredTranscriptSeq: number;
            deliveredReadyEventSeq: number;
            deliveredAgentStateVersion: number;
            deliveredTurnId: string | null;
            deliveredTurnStatus: string | null;
        }>>`SELECT "sourceSessionId" AS "sessionId", "destinationSessionId" AS "leadSessionId", "attachedAt",
            "deliveredTranscriptSeq", "deliveredReadyEventSeq", "deliveredAgentStateVersion", "deliveredTurnId", "deliveredTurnStatus"
            FROM "SessionFollowEdge" WHERE "managerSourceSessionId" = ${child.id}`;
        expect(rows).toEqual([{
            sessionId: child.id,
            leadSessionId: lead.id,
            attachedAt,
            deliveredTranscriptSeq: 7,
            deliveredReadyEventSeq: 3,
            deliveredAgentStateVersion: 2,
            deliveredTurnId: 'turn-report',
            deliveredTurnStatus: 'completed',
        }]);

        await db.session.delete({ where: { id: lead.id } });
        await db.session.delete({ where: { id: deletedChild.id } });
        expect(await db.$queryRaw`SELECT "sourceSessionId" FROM "SessionFollowEdge" WHERE "relation" = 'manager'`).toEqual([]);
        expect(await db.session.findUnique({ where: { id: child.id }, select: { id: true } })).toEqual({ id: child.id });
        expect(await db.session.findUnique({ where: { id: survivingLead.id }, select: { id: true } })).toEqual({ id: survivingLead.id });
    });
});
