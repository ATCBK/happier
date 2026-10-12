import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from "@/app/session/access/sessionRecipients";
import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { getSessionLifecycleAutomationPublicationAudienceInTx } from "@/app/workflows/workflowPublicationAudience";

/**
 * Acquire publication's Account locks before taking any Session write lock.
 * Lock the complete current audience in id order, including the owning Account
 * even when inactive. The caller still admits owner/access/publisher authority
 * inside this transaction; this is a cursor fence, not a grant or mode decision.
 * Account-mode writers retain their stronger owner-metadata fence unchanged.
 */
export async function acquireSessionAccountCursorLocksInTx(
    tx: Tx,
    sessionIds: readonly string[],
    additionalAccountIds: readonly string[] = [],
    options?: Readonly<{ includeLifecyclePublications?: boolean }>,
): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    // SQLite has one database writer rather than independently lockable rows.
    if (provider === "sqlite") return;
    const ids = [...new Set(sessionIds)].sort();
    if (ids.length === 0 && additionalAccountIds.length === 0) return;
    const readAudience = async () => {
        const lifecycle = options?.includeLifecyclePublications
            ? await getSessionLifecycleAutomationPublicationAudienceInTx(tx, ids)
            : { sessionIds: [], accountIds: [] };
        const sourceSessionIds = [...new Set([...ids, ...lifecycle.sessionIds])].sort();
        // Source publication invalidates its direct ReportsTo lead projection as
        // well. Follow's destination wake is socket-only and allocates no cursor.
        const reportsTo = sourceSessionIds.length > 0 ? await tx.sessionReportsTo.findMany({
            where: { sessionId: { in: sourceSessionIds } }, select: { leadSessionId: true },
        }) : [];
        const projectionSessionIds = [...new Set([...sourceSessionIds, ...reportsTo.map(edge => edge.leadSessionId)])].sort();
        const recipients = await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, {
            sessionIds: projectionSessionIds, includeUnpublishedGrants: true, includeInactiveAccounts: true,
        });
        const accountIds = [...new Set([...recipients.values()].flat().concat([...additionalAccountIds], lifecycle.accountIds))].sort();
        return { projectionSessionIds, accountIds };
    };
    const { projectionSessionIds, accountIds } = await readAudience();
    let lockedAccounts: { id: string }[];
    if (provider === "postgres") {
        lockedAccounts = await tx.$queryRawUnsafe<{ id: string }[]>(
            'SELECT "id" FROM "Account" WHERE "id" = ANY($1::text[]) OR "id" IN (SELECT "accountId" FROM "Session" WHERE "id" = ANY($2::text[])) ORDER BY "id" FOR NO KEY UPDATE',
            accountIds, projectionSessionIds,
        );
    } else {
        const conditions: string[] = [];
        if (accountIds.length > 0) conditions.push(`\`id\` IN (${accountIds.map(() => "?").join(", ")})`);
        if (projectionSessionIds.length > 0) conditions.push(`\`id\` IN (SELECT \`accountId\` FROM \`Session\` WHERE \`id\` IN (${projectionSessionIds.map(() => "?").join(", ")}))`);
        lockedAccounts = await tx.$queryRawUnsafe<{ id: string }[]>(
            `SELECT \`id\` FROM \`Account\` WHERE ${conditions.join(" OR ")} ORDER BY \`id\` FOR UPDATE`,
            ...accountIds, ...projectionSessionIds,
        );
    }
    // ReadCommitted can admit a grant or ReportsTo change between discovery
    // and lock acquisition. Never extend a captured lock set out of order:
    // roll back and let inTx replay the complete transaction on its own budget.
    const current = await readAudience();
    const owners = current.projectionSessionIds.length > 0 ? await tx.session.findMany({
        where: { id: { in: current.projectionSessionIds } }, select: { accountId: true },
    }) : [];
    const lockedAccountIds = new Set(lockedAccounts.map(account => account.id));
    if ([...current.accountIds, ...owners.map(session => session.accountId)].some(id => !lockedAccountIds.has(id))) {
        throw new TransactionReplayRequiredError("session-account-audience-changed");
    }
}
