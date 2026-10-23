import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '@/storage/inTx';
import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from './sessionRecipients';

describe('Session recipient transport bind budget', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('keeps every Session/share/Team/Group acquisition below the portable bind boundary without losing recipients', async () => {
        vi.stubEnv('HAPPIER_FEATURE_SHARING__SESSION_ENABLED', '1');
        const sessionIds = Array.from({ length: 1100 }, (_, index) => `session-${index}`);
        const acquisitions: Array<{ kind: string; ids: readonly string[] }> = [];
        const selected = (kind: string, input: { where: { id?: { in: readonly string[] }; sessionId?: { in: readonly string[] } } }) => {
            const ids = input.where.id?.in ?? input.where.sessionId?.in ?? [];
            acquisitions.push({ kind, ids });
            return ids;
        };
        // The persistent database is the only substituted boundary; publication, feature and recipient logic stay real.
        const tx = {
            session: { findMany: async (input: Parameters<typeof selected>[1]) => selected('Session', input).map(id => ({
                id, accountId: 'owner', seq: 0, currentStorageState: 'hosted', acceptedThroughServerSeq: null,
                materializationPublicationId: null, materializedThroughSourceAt: null, publishedThroughServerSeq: null,
                account: { status: 'active' },
            })) },
            sessionShare: { findMany: async (input: Parameters<typeof selected>[1]) => selected('Share', input)
                .map(sessionId => ({ sessionId, sharedWithUserId: 'direct' })) },
            sessionTeamGrant: { findMany: async (input: Parameters<typeof selected>[1]) => selected('Team', input)
                .map(sessionId => ({ sessionId, effectiveAt: new Date(1), team: {
                    memberships: [{ accountId: 'team', sessionAccessStartsAt: new Date(0) }],
                } })) },
            sessionGroupGrant: { findMany: async (input: Parameters<typeof selected>[1]) => selected('Group', input)
                .map(sessionId => ({ sessionId, effectiveAt: new Date(1), teamGroup: {
                    memberships: [{ teamMembership: { accountId: 'group' }, sessionAccessStartsAt: new Date(0) }],
                } })) },
        } as unknown as Tx;
        const result = await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: ['', ...sessionIds, sessionIds[0]!] });
        expect(result.size).toBe(sessionIds.length);
        for (const id of sessionIds) expect(result.get(id)).toEqual(['direct', 'group', 'owner', 'team']);
        for (const kind of ['Session', 'Share', 'Team', 'Group']) {
            const reads = acquisitions.filter(read => read.kind === kind);
            expect(reads.length).toBeGreaterThan(0);
            expect(reads.flatMap(read => read.ids)).toEqual(sessionIds);
            // Worst nested membership predicates: status, Account status, guest role, plus Prisma OFFSET.
            expect(Math.max(...reads.map(read => read.ids.length + 4))).toBeLessThanOrEqual(999);
        }
    });
});
