import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '@/storage/prisma';
import { buildProviderAccountUsagePageProjectionV1, sealProviderAccountUsagePageProjectionV1 } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { readProviderAccountUsagePageProjection, writeProviderAccountUsagePageProjection } from './pageProjectionStorage';

const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
    providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: 1, fetchedAtMs: 1,
    staleAfterMs: 100, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] });
const demand = { range: { startAtMs: 0, endAtMs: 3 }, resolution: 'accepted_observations' as const };
const frontier = { id: 'accepted', observedAtMs: 1 };
const value = { recordId: snapshot.recordId, demand, frontier, observationCount: 1,
    content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection: buildProviderAccountUsagePageProjectionV1({
        recordId: snapshot.recordId, range: demand.range, history: { entries: [{ ...frontier, snapshot }], nextCursor: null },
    }) }) };

function databaseBoundary() {
    const findUnique = vi.fn().mockResolvedValue({ metadata: { materialFingerprint: 'retained', pageProjection: value } });
    const count = vi.fn().mockResolvedValue(1);
    const findFirst = vi.fn().mockResolvedValue({ id: frontier.id, observedAt: new Date(frontier.observedAtMs) });
    const update = vi.fn().mockResolvedValue({});
    // Prisma is the genuine database boundary. The integration suite owns SQL,
    // transaction/source admission and exact immutable witness verification.
    const storage = { providerAccountUsageRecord: { findUnique, update }, providerAccountUsageHistory: { count, findFirst } } as unknown as
        Pick<TransactionClient, 'providerAccountUsageRecord' | 'providerAccountUsageHistory'>;
    return { storage, findUnique, count, findFirst, update };
}

describe('B page projection persistence', () => {
    it('reuses a complete admitted prefix and distinguishes a new tail from a changed prefix', async () => {
        const db = databaseBoundary();
        const params = { accountId: 'owner', recordId: snapshot.recordId, projection: demand };
        expect(await readProviderAccountUsagePageProjection(params, db.storage)).toEqual({ projection: value, complete: true });
        db.count.mockReset().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
        expect(await readProviderAccountUsagePageProjection(params, db.storage)).toEqual({ projection: value, complete: false });
        db.count.mockReset().mockResolvedValue(2);
        expect(await readProviderAccountUsagePageProjection(params, db.storage)).toEqual({ projection: null, complete: false });
        expect(await readProviderAccountUsagePageProjection({ ...params, projection: { ...demand, range: { startAtMs: 0, endAtMs: 5 } } }, db.storage))
            .toEqual({ projection: null, complete: false });
    });

    it('admits only the complete accepted count/frontier and preserves sibling metadata', async () => {
        const db = databaseBoundary();
        expect(await writeProviderAccountUsagePageProjection({ accountId: 'owner', value }, db.storage)).toBe(true);
        expect(db.update.mock.calls[0]?.[0].data.metadata).toEqual({ materialFingerprint: 'retained', pageProjection: value });
        db.update.mockClear();
        db.count.mockResolvedValue(2);
        expect(await writeProviderAccountUsagePageProjection({ accountId: 'owner', value }, db.storage)).toBe(false);
        expect(db.update).not.toHaveBeenCalled();
        db.count.mockResolvedValue(1);
        db.findFirst.mockResolvedValue({ id: 'different', observedAt: new Date(1) });
        expect(await writeProviderAccountUsagePageProjection({ accountId: 'owner', value }, db.storage)).toBe(false);
        expect(db.update).not.toHaveBeenCalled();
    });
});
