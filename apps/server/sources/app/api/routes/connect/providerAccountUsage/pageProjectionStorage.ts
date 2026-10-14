import type { TransactionClient } from '@/storage/prisma';
import type { ProviderAccountUsagePageProjectionDemandV1Schema, ProviderAccountUsagePageProjectionWriteV1Schema } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import type { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { StoredProviderAccountUsagePageProjectionV1Schema } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { ProviderAccountUsagePayloadInvariantError } from './types';

type ProjectionStorage = Pick<TransactionClient, 'providerAccountUsageRecord' | 'providerAccountUsageHistory'>;
type ProjectionWrite = z.infer<typeof ProviderAccountUsagePageProjectionWriteV1Schema>;

export async function readProviderAccountUsagePageProjection(
    params: Readonly<{ accountId: string; recordId: string; projection: z.infer<typeof ProviderAccountUsagePageProjectionDemandV1Schema> }>,
    storage: ProjectionStorage,
): Promise<{ projection: ProjectionWrite | null; complete: boolean }> {
    const missing = { projection: null, complete: false };
    const row = await storage.providerAccountUsageRecord.findUnique({
        where: { accountId_recordId: { accountId: params.accountId, recordId: params.recordId } }, select: { metadata: true },
    });
    const metadata = row?.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !('pageProjection' in metadata) || !metadata.pageProjection) return missing;
    const parsed = StoredProviderAccountUsagePageProjectionV1Schema.safeParse(metadata.pageProjection);
    if (!parsed.success || parsed.data.recordId !== params.recordId) throw new ProviderAccountUsagePayloadInvariantError('Invalid B page projection');
    const projection = parsed.data;
    if (projection.demand.range.startAtMs > params.projection.range.startAtMs) return missing;
    const where = { accountId: params.accountId, recordId: params.recordId,
        observedAt: { gte: new Date(projection.demand.range.startAtMs), lt: new Date(projection.demand.range.endAtMs) } };
    const prefix = projection.frontier ? { ...where, OR: [
        { observedAt: { lt: new Date(projection.frontier.observedAtMs) } },
        { observedAt: new Date(projection.frontier.observedAtMs), id: { lte: projection.frontier.id } },
    ] } : where;
    const [count, last] = await Promise.all([
        storage.providerAccountUsageHistory.count({ where: prefix }),
        storage.providerAccountUsageHistory.findFirst({ where: prefix, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }], select: { id: true, observedAt: true } }),
    ]);
    // A changed prefix needs a full backfill. Appending only a tail would lose
    // a late/backdated accepted observation or retain a removed witness.
    if (!sameCoverage(projection, count, last)) return missing;
    const total = await storage.providerAccountUsageHistory.count({ where: { ...where,
        observedAt: { gte: where.observedAt.gte, lt: new Date(Math.max(projection.demand.range.endAtMs, params.projection.range.endAtMs)) } } });
    return { projection, complete: total === projection.observationCount };
}

/** Called only after qualified source/Account-mode admission, in that transaction. */
export async function writeProviderAccountUsagePageProjection(
    params: Readonly<{ accountId: string; value: ProjectionWrite }>,
    storage: ProjectionStorage,
): Promise<boolean> {
    const { value } = params;
    const where = { accountId: params.accountId, recordId: value.recordId,
        observedAt: { gte: new Date(value.demand.range.startAtMs), lt: new Date(value.demand.range.endAtMs) } };
    const [count, last, row] = await Promise.all([
        storage.providerAccountUsageHistory.count({ where }),
        storage.providerAccountUsageHistory.findFirst({ where, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }], select: { id: true, observedAt: true } }),
        storage.providerAccountUsageRecord.findUnique({ where: { accountId_recordId: { accountId: params.accountId, recordId: value.recordId } }, select: { metadata: true } }),
    ]);
    if (!row || !sameCoverage(value, count, last)) return false;
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};
    await storage.providerAccountUsageRecord.update({
        where: { accountId_recordId: { accountId: params.accountId, recordId: value.recordId } },
        data: { metadata: { ...metadata, pageProjection: value } as Prisma.InputJsonValue },
    });
    return true;
}

function sameCoverage(value: ProjectionWrite, count: number, last: { id: string; observedAt: Date } | null) {
    return count === value.observationCount && (last ? last.id === value.frontier?.id
        && last.observedAt.getTime() === value.frontier.observedAtMs : value.frontier === null);
}
