import type { Prisma } from "@prisma/client";
import { inTx } from "@/storage/inTx";

import {
    deriveSessionTurnTranscriptAnchorProjection,
    isSessionTurnTranscriptAnchorProjectionCurrent,
} from "./sessionTurnTranscriptAnchorProjection";

export const SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_BACKFILL_PAGE_MAX = 500;

type BackfillClient = Pick<Prisma.TransactionClient, "sessionTurn">;

type SessionTurnTranscriptAnchorProjectionRow = Readonly<{
    id: string;
    transcriptAnchorsJson: string | null;
    transcriptAnchorProjectionVersion: number;
    transcriptAnchorMinSeq: number | null;
    transcriptAnchorMaxSeq: number | null;
}>;

function resolvePageLimit(value: number | undefined): number {
    return Math.max(
        1,
        Math.min(
            SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_BACKFILL_PAGE_MAX,
            Math.floor(value ?? 100),
        ),
    );
}

function hasCurrentProjection(row: SessionTurnTranscriptAnchorProjectionRow): boolean {
    return isSessionTurnTranscriptAnchorProjectionCurrent(row);
}

async function readProjectionRows(params: Readonly<{
    db: BackfillClient;
    afterId?: string;
    limit: number;
}>): Promise<readonly SessionTurnTranscriptAnchorProjectionRow[]> {
    return await params.db.sessionTurn.findMany({
        where: params.afterId === undefined ? undefined : { id: { gt: params.afterId } },
        orderBy: { id: "asc" },
        take: params.limit,
        select: {
            id: true,
            transcriptAnchorsJson: true,
            transcriptAnchorProjectionVersion: true,
            transcriptAnchorMinSeq: true,
            transcriptAnchorMaxSeq: true,
        },
    });
}

/**
 * Derive every scalar only from the current row JSON. The snapshot predicate
 * lets a concurrent capable writer win without this recovery pass restoring a
 * stale projection over its newer anchors.
 */
export async function backfillSessionTurnTranscriptAnchorProjectionPage(params: Readonly<{
    db: BackfillClient;
    afterId?: string;
    limit?: number;
}>): Promise<Readonly<{ processed: number; updated: number; nextAfterId: string | null }>> {
    const limit = resolvePageLimit(params.limit);
    const rows = await readProjectionRows({
        db: params.db,
        ...(params.afterId === undefined ? {} : { afterId: params.afterId }),
        limit,
    });
    let updated = 0;

    for (const row of rows) {
        if (hasCurrentProjection(row)) continue;
        const projection = deriveSessionTurnTranscriptAnchorProjection(row.transcriptAnchorsJson);
        const result = await params.db.sessionTurn.updateMany({
            where: {
                id: row.id,
                transcriptAnchorsJson: row.transcriptAnchorsJson,
                transcriptAnchorProjectionVersion: row.transcriptAnchorProjectionVersion,
                transcriptAnchorMinSeq: row.transcriptAnchorMinSeq,
                transcriptAnchorMaxSeq: row.transcriptAnchorMaxSeq,
            },
            data: projection,
        });
        updated += result.count;
    }

    return {
        processed: rows.length,
        updated,
        nextAfterId: rows.length === limit ? rows.at(-1)?.id ?? null : null,
    };
}

/**
 * Run before API admission on fresh installs and forward upgrades. Each page
 * uses the converter's existing bounded transaction; a restart rescans safely
 * because current projections are skipped and updates retain their snapshot
 * predicate. Current turn writers publish JSON and v1 scalars together.
 */
export async function initializeSessionTurnTranscriptAnchorProjection(signal?: AbortSignal): Promise<void> {
    let afterId: string | undefined;
    while (true) {
        signal?.throwIfAborted();
        const page = await inTx(tx => backfillSessionTurnTranscriptAnchorProjectionPage({ db: tx, afterId }));
        signal?.throwIfAborted();
        if (page.nextAfterId === null) return;
        afterId = page.nextAfterId;
    }
}
