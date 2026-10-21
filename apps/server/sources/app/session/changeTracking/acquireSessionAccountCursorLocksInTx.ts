import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from "@/app/session/access/sessionRecipients";
import { inReadSnapshot, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { resolveDbSqlDialect } from "@/config/databaseProvider";
import { getSessionLifecycleAutomationPublicationAudienceInTx } from "@/app/workflows/workflowPublicationAudience";
import { hasSessionFollowSessionSource } from "@/app/session/follow/sessionFollowSourceIdentity";
import { acquireAccountChangePublicationLocksInTx, assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication } from "@/app/changes/markAccountChanged";
import type { AccountAdmissionIntent } from "@/app/encryption/accountSessionOwnerMetadataFence";

export type SessionAccountCursorLockOptions = Readonly<{
    includeLifecyclePublications?: boolean;
    intent?: AccountAdmissionIntent;
    /** Prospective recipients/authority scopes supplied by the mutation owner.
     * Pure census only: every fence and publication recheck repeats this read. */
    readAdditionalAccountIdsInTx?: (tx: Tx) => Promise<readonly string[]>;
}>;

/** One census serves pre-attempt discovery and transactional currentness checks. */
export async function readSessionAccountCursorAudienceInTx(
    tx: Tx,
    sessionIds: readonly string[],
    additionalAccountIds: readonly string[],
    options?: SessionAccountCursorLockOptions,
) {
    const ids = [...new Set(sessionIds)].sort();
    const lifecycle = options?.includeLifecyclePublications
        ? await getSessionLifecycleAutomationPublicationAudienceInTx(tx, ids)
        : { sessionIds: [], accountIds: [] };
    const sourceSessionIds = [...new Set([...ids, ...lifecycle.sessionIds])].sort();
    // Every outgoing relation publishes a destination cursor. Archive/rejoin
    // also invalidates incoming Manager children, so fence both endpoints there.
    const relationEdges = sourceSessionIds.length > 0 ? await tx.sessionFollowEdge.findMany({
        where: { OR: [{ sourceSessionId: { in: sourceSessionIds } }, { sourceExecutionRunSessionId: { in: sourceSessionIds } },
            { relation: 'manager', destinationSessionId: { in: sourceSessionIds } }] },
        select: { sourceSessionId: true, destinationSessionId: true },
    }) : [];
    const projectionSessionIds = [...new Set([
        ...sourceSessionIds, ...relationEdges.map(edge => edge.destinationSessionId),
        ...relationEdges.filter(hasSessionFollowSessionSource).map(edge => edge.sourceSessionId),
    ])].sort();
    const recipients = await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, {
        sessionIds: projectionSessionIds, includeUnpublishedGrants: true, includeInactiveAccounts: true,
    });
    const additionalAudience = await options?.readAdditionalAccountIdsInTx?.(tx) ?? [];
    const accountIds = [...new Set([...recipients.values()].flat().concat([...additionalAccountIds], lifecycle.accountIds, [...additionalAudience]))].sort();
    return { projectionSessionIds, accountIds };
}

/** Discover outside the mutation snapshot; fence and verify inside each attempt. */
export async function prepareSessionAccountCursorLocks(
    sessionIds: readonly string[],
    additionalAccountIds: readonly string[] = [],
    options?: SessionAccountCursorLockOptions,
): Promise<(tx: Tx) => Promise<void>> {
    if (getDbProviderFromEnv(process.env, "postgres") === "sqlite") return async () => {};
    const audience = await inReadSnapshot(tx => readSessionAccountCursorAudienceInTx(tx, sessionIds, additionalAccountIds, options));
    return async tx => { await fenceSessionAccountCursorAudienceInTx(tx, audience, sessionIds, additionalAccountIds, options); };
}

/**
 * Admit the complete Account audience before locking the Session resources.
 * PostgreSQL ordinary admission is compatible with unrelated cursor writers;
 * exclusive admission is selected at entry by transition/lifecycle owners.
 * Account cursor locks are acquired only by terminal publication. MySQL retains
 * exclusive entry admission, and SQLite retains its single-writer lifecycle.
 */
export async function acquireSessionAccountCursorLocksInTx(
    tx: Tx,
    sessionIds: readonly string[],
    additionalAccountIds: readonly string[] = [],
    options?: SessionAccountCursorLockOptions,
): Promise<readonly string[]> {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    // SQLite has one database writer rather than independently lockable rows.
    if (provider === "sqlite") return [];
    const audience = await readSessionAccountCursorAudienceInTx(tx, sessionIds, additionalAccountIds, options);
    return fenceSessionAccountCursorAudienceInTx(tx, audience, sessionIds, additionalAccountIds, options);
}

/** Reuse a complete captured audience without extending its resource lock set. */
export async function fenceSessionAccountCursorAudienceInTx(
    tx: Tx,
    { projectionSessionIds, accountIds }: Readonly<{ projectionSessionIds: readonly string[]; accountIds: readonly string[] }>,
    sessionIds: readonly string[],
    additionalAccountIds: readonly string[],
    options?: SessionAccountCursorLockOptions,
): Promise<readonly string[]> {
    if (projectionSessionIds.length === 0 && accountIds.length === 0) return [];
    await acquireAccountChangePublicationLocksInTx(tx, accountIds, {
        includeSingleAccount: true,
        intent: options?.intent ?? "content",
    });
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, "postgres"));
    // Direct captured-audience callers still reserve SQLite's single writer,
    // without querying independently lockable resource scopes it does not have.
    if (dialect === "sqlite") return accountIds;
    const admittedAccountIds = new Set(accountIds);
    const admittedSessionIds = new Set(projectionSessionIds);
    const validateInitialAudience = async () => {
        const current = await readSessionAccountCursorAudienceInTx(tx, sessionIds, additionalAccountIds, options);
        if (current.accountIds.some(id => !admittedAccountIds.has(id))
            || current.projectionSessionIds.some(id => !admittedSessionIds.has(id))) {
            throw new TransactionReplayRequiredError("session-account-audience-changed");
        }
    };
    await validateInitialAudience();
    if (projectionSessionIds.length > 0) {
        if (dialect === "postgres") {
            await tx.$queryRawUnsafe(
                'SELECT "id" FROM "Session" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR NO KEY UPDATE',
                projectionSessionIds,
            );
        } else if (dialect === "mysql") {
            await tx.$queryRawUnsafe(
                `SELECT \`id\` FROM \`Session\` WHERE \`id\` IN (${projectionSessionIds.map(() => "?").join(", ")}) ORDER BY \`id\` FOR UPDATE`,
                ...projectionSessionIds,
            );
        }
    }
    // ReadCommitted can admit a grant or manager change between discovery
    // and lock acquisition. Never extend a captured lock set out of order:
    // roll back and let inTx replay the complete transaction on its own budget.
    await validateInitialAudience();
    beforeAccountChangePublication(tx, accountIds, async client => {
        const current = await readSessionAccountCursorAudienceInTx(client, sessionIds, additionalAccountIds, options);
        assertAccountChangePublicationAudienceInTx(client, current.accountIds);
    });
    return accountIds;
}
