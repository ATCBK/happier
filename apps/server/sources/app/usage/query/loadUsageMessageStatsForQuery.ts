import type { UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import {
    buildSessionMessagesPublicationWhere,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { inTx, type Tx } from "@/storage/inTx";

export type UsageMessageCounts = {
    messageCount: number;
};

function toObservedAtFilter(request: UsageAnalyticsQueryRequest) {
    if (!request.dateRange) {
        return undefined;
    }

    return {
        gte: request.dateRange.startMs !== undefined ? new Date(request.dateRange.startMs) : undefined,
        lt: request.dateRange.endMs !== undefined ? new Date(request.dateRange.endMs) : undefined,
    };
}

export async function loadUsageMessageStatsForQuery(
    accountId: string,
    request: UsageAnalyticsQueryRequest,
    sessionIds: string[],
): Promise<UsageMessageCounts> {
    const counts = await inTx(tx => loadUsageMessageCountsBySessionInTx(tx, accountId, request, sessionIds), { readOnly: true });
    return { messageCount: [...counts.values()].reduce((total, count) => total + count, 0) };
}

/** Candidate Sessions can be filtered after accounting reconciliation without another DB read. */
export async function loadUsageMessageCountsBySessionInTx(
    tx: Tx,
    accountId: string,
    request: UsageAnalyticsQueryRequest,
    sessionIds: string[],
): Promise<ReadonlyMap<string, number>> {
    if (sessionIds.length === 0) {
        return new Map();
    }

    const publicationRows = await tx.session.findMany({
        where: {
            id: { in: sessionIds },
            accountId,
        },
        select: {
            id: true,
            ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
        },
    });
    const counts = await tx.sessionMessage.groupBy({
        by: ['sessionId'],
        _count: { _all: true },
        where: {
            ...buildSessionMessagesPublicationWhere(publicationRows),
            createdAt: toObservedAtFilter(request),
            session: {
                accountId,
            },
        },
    });

    return new Map(counts.map(row => [row.sessionId, row._count._all]));
}
