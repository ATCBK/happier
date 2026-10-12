import { db } from "@/storage/db";
import { warn } from "@/utils/logging/log";
import { deriveSessionMessageAuthorAccountIdV1 } from "@happier-dev/protocol";

export type SessionMessageAuthorProjectionBackfillResult = Readonly<{
    /** False when any pre-existing row disagreed with its receipt; activation must not proceed. */
    ok: boolean;
    scanned: number;
    filled: number;
    disagreements: number;
}>;

const DEFAULT_BATCH_SIZE = 500;

/**
 * One-time, provider-neutral, idempotent population of the derived
 * `SessionMessage.authorAccountId` query projection.
 *
 * It keyset-pages rows by primary key, parses each stored receipt
 * with the canonical Protocol parser, and fills only a still-null projection
 * from an exact valid authenticated-Account receipt whose Account still exists.
 * Machine, absent, malformed, unknown-version, non-user, and deleted-Account
 * rows are deliberately left null: missing evidence cannot be reconstructed
 * from Session ownership, content, timestamps, or descriptive provenance.
 *
 * A pre-existing non-null row that disagrees with its receipt is reported and
 * fails the run rather than being "repaired" in either direction; the receipt
 * bytes are never rewritten.
 *
 * No checkpoint, queue, or worker is needed: an interrupted scan safely
 * restarts, and deployment runs this once after the current-writer cutover (and
 * again after a supported interrupted upgrade) before Lane 09 activates its
 * author-based personal scopes.
 */
export async function backfillSessionMessageAuthorProjection(options?: Readonly<{
    batchSize?: number;
    client?: Pick<typeof db, "sessionMessage" | "account">;
}>): Promise<SessionMessageAuthorProjectionBackfillResult> {
    const client = options?.client ?? db;
    const batchSize = Math.max(1, options?.batchSize ?? DEFAULT_BATCH_SIZE);
    let cursorId: string | null = null;
    let scanned = 0;
    let filled = 0;
    let disagreements = 0;

    for (;;) {
        const rows: Array<{
            id: string;
            messageRole: string | null;
            inputAdmissionReceipt: unknown;
            authorAccountId: string | null;
        }> = await client.sessionMessage.findMany({
            // Include missing/invalid receipts: a non-null projection on such
            // a row is also a disagreement that must block activation.
            where: {
                ...(cursorId === null ? {} : { id: { gt: cursorId } }),
            },
            orderBy: { id: "asc" },
            take: batchSize,
            select: {
                id: true,
                messageRole: true,
                inputAdmissionReceipt: true,
                authorAccountId: true,
            },
        });
        if (rows.length === 0) break;
        cursorId = rows[rows.length - 1]!.id;
        scanned += rows.length;

        const candidates = rows.flatMap((row) => {
            const actorAccountId = deriveSessionMessageAuthorAccountIdV1({
                messageRole: row.messageRole,
                inputAdmissionReceipt: row.inputAdmissionReceipt,
            }, 'stored');
            if (row.authorAccountId != null) {
                if (row.authorAccountId !== actorAccountId) {
                    disagreements += 1;
                    warn({
                        event: "session_message_author_projection_backfill_disagreement",
                        messageId: row.id,
                    }, "Stored Session message author projection disagrees with its admission receipt");
                }
                return [];
            }
            if (actorAccountId === null) return [];
            return [{ id: row.id, actorAccountId }];
        });
        if (candidates.length === 0) continue;

        // `onDelete: SetNull` means a deleted actor cannot hold the FK, so the
        // backfill resolves survivors before writing rather than failing the batch.
        const survivingAccountIds = new Set((await client.account.findMany({
            where: { id: { in: [...new Set(candidates.map((candidate) => candidate.actorAccountId))] } },
            select: { id: true },
        })).map((account) => account.id));

        for (const candidate of candidates) {
            if (!survivingAccountIds.has(candidate.actorAccountId)) continue;
            // Conditional on the projection still being null so a concurrent
            // current writer always wins and a rerun stays idempotent.
            const updated = await client.sessionMessage.updateMany({
                where: { id: candidate.id, authorAccountId: null },
                data: { authorAccountId: candidate.actorAccountId },
            });
            filled += updated.count;
        }
    }

    return { ok: disagreements === 0, scanned, filled, disagreements };
}
