import { getTransactionContext, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { resolveDbSqlDialect } from "@/config/databaseProvider";

export type AccountAdmissionIntent = "content" | "serializing" | "exclusive";

const admissionStrength = { content: 0, serializing: 1, exclusive: 2 } as const;

const admissionSymbol = Symbol("account-admission");
type AccountAdmission = { readonly strength: number; held: boolean };
type AdmissionContext = { [admissionSymbol]?: ReadonlyMap<string, AccountAdmission> };

function assertManagedAdmissionAudience(tx: Tx, ids: readonly string[], strength: number) {
    const context = getTransactionContext(tx, { optional: true });
    // Unmanaged callers retain the primitive SQL contract. Read snapshots do
    // not participate in a managed write transaction's publication ordering.
    if (!context || context.readOnly) return;
    const owner = context as typeof context & AdmissionContext;
    const admitted = owner[admissionSymbol];
    if (!admitted) {
        return owner[admissionSymbol] = new Map(ids.map(id => [id, { strength, held: false }]));
    }
    if (ids.some(id => !admitted.has(id) || strength > admitted.get(id)!.strength)) {
        // The first batch must contain all prospective publication recipients.
        // Never acquire a newly discovered or stronger lock after domain work.
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
    return admitted;
}

/** Verify queued recipients against the same entry cohort, without acquiring locks. */
export function assertAccountSessionOwnerMetadataAdmissionAudienceInTx(tx: Tx, accountIds: readonly string[]): void {
    // SQLite's single writer cannot form a row-lock audience cycle. Its Session
    // writers deliberately avoid the row-provider audience census.
    if (getDbProviderFromEnv(process.env, "postgres") === "sqlite") return;
    const context = getTransactionContext(tx, { optional: true });
    if (!context || context.readOnly) return;
    const admitted = (context as typeof context & AdmissionContext)[admissionSymbol];
    // Pure allocator consumers have no domain admission cohort to extend.
    if (admitted && accountIds.some(id => !admitted.has(id))) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
}

export class AccountSessionOwnerMetadataFenceAccountNotFoundError extends Error {
    constructor(accountId: string) {
        super(
            `Account Session owner-metadata fence requires exactly one Account row for ${accountId}`,
        );
        this.name = "AccountSessionOwnerMetadataFenceAccountNotFoundError";
    }
}

function assertExactlyOneAccountRow(
    rowCount: number,
    accountId: string,
): void {
    if (rowCount === 0) {
        throw new AccountSessionOwnerMetadataFenceAccountNotFoundError(accountId);
    }
    if (rowCount !== 1) {
        throw new Error(
            `Account Session owner-metadata fence requires exactly one Account row for ${accountId}`,
        );
    }
}

/**
 * Admits ordinary content before resource locking, serializes aggregate writers
 * compatibly with content admission, or excludes content for Account authority
 * changes. PostgreSQL publication later takes NO KEY UPDATE; callers must choose
 * their strongest intent at entry rather than upgrading after domain work.
 *
 * PostgreSQL-compatible providers and MySQL lock the Account row directly. SQLite reserves
 * the database writer with a bound no-op column update so Prisma's `@updatedAt` behavior is
 * not invoked.
 */
export async function acquireAccountSessionOwnerMetadataFenceInTx(
    tx: Tx,
    accountId: string,
    intent: AccountAdmissionIntent,
): Promise<void> {
    const ids = await acquireAccountSessionOwnerMetadataFencesInTx(tx, [accountId], intent);
    assertExactlyOneAccountRow(ids.length, accountId);
}

/** Admit a complete sorted audience; absent recipients are not publication targets. */
export async function acquireAccountSessionOwnerMetadataFencesInTx(
    tx: Tx,
    accountIds: readonly string[],
    intent: AccountAdmissionIntent,
): Promise<readonly string[]> {
    const ids = [...new Set(accountIds)].sort();
    if (ids.length === 0) return [];
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, "postgres"));
    const admitted = dialect !== "sqlite"
        ? assertManagedAdmissionAudience(tx, ids, admissionStrength[dialect === "mysql" ? "exclusive" : intent]) : undefined;
    // Native row locks survive until the containing attempt ends. Nested
    // owners need no second SQL/budget refresh for an already-held cohort.
    // Missing rows and failed acquisitions must never count as held locks;
    // unmanaged/read-snapshot callers retain their primitive SQL behavior.
    if (admitted && ids.every(id => admitted.get(id)?.held)) return ids;

    if (dialect === "sqlite") {
        const present: string[] = [];
        for (const id of ids) {
            const affectedRows = await tx.$executeRawUnsafe(
                'UPDATE "Account" SET "settingsVersion" = "settingsVersion" WHERE "id" = ?',
                id,
            );
            if (affectedRows !== 0) {
                assertExactlyOneAccountRow(affectedRows, id);
                present.push(id);
            }
        }
        return present;
    }

    const mode = intent === "content" ? "KEY SHARE" : intent === "serializing" ? "NO KEY UPDATE" : "UPDATE";
    // MySQL has no compatible key-share/non-key-update pair. Its approved
    // admission contract retains the early exclusive fence for every intent.
    const query = dialect === "mysql"
        ? ids.length === 1
            ? "SELECT `id` FROM `Account` WHERE `id` = ? FOR UPDATE"
            : `SELECT \`id\` FROM \`Account\` WHERE \`id\` IN (${ids.map(() => "?").join(", ")}) ORDER BY \`id\` FOR UPDATE`
        : ids.length === 1
            ? `SELECT "id" FROM "Account" WHERE "id" = $1 FOR ${mode}`
            : `SELECT "id" FROM "Account" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR ${mode}`;
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        query,
        ...(dialect === "mysql" || ids.length === 1 ? ids : [ids]),
    );
    const present = rows.map(row => row.id);
    if (new Set(present).size !== present.length) {
        throw new Error(`Account Session owner-metadata fence requires exactly one Account row for ${ids.join(", ")}`);
    }
    for (const id of present) {
        const admission = admitted?.get(id);
        if (admission) admission.held = true;
    }
    return present;
}
