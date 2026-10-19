import type { Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";

export type AccountAdmissionIntent = "content" | "exclusive";

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
 * Admits ordinary content before resource locking, or excludes those writers for
 * Account authority and aggregate mutations. PostgreSQL publication later takes
 * its compatible NO KEY UPDATE lock; callers must choose their strongest intent
 * at entry rather than upgrading content admission.
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
    const provider = getDbProviderFromEnv(process.env, "postgres");

    if (provider === "sqlite") {
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

    const mode = intent === "content" ? "KEY SHARE" : "UPDATE";
    // MySQL has no compatible key-share/non-key-update pair. Its approved
    // admission contract retains the early exclusive fence for both intents.
    const query = provider === "mysql"
        ? ids.length === 1
            ? "SELECT `id` FROM `Account` WHERE `id` = ? FOR UPDATE"
            : `SELECT \`id\` FROM \`Account\` WHERE \`id\` IN (${ids.map(() => "?").join(", ")}) ORDER BY \`id\` FOR UPDATE`
        : ids.length === 1
            ? `SELECT "id" FROM "Account" WHERE "id" = $1 FOR ${mode}`
            : `SELECT "id" FROM "Account" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR ${mode}`;
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        query,
        ...(provider === "mysql" || ids.length === 1 ? ids : [ids]),
    );
    const present = rows.map(row => row.id);
    if (new Set(present).size !== present.length) {
        throw new Error(`Account Session owner-metadata fence requires exactly one Account row for ${ids.join(", ")}`);
    }
    return present;
}
