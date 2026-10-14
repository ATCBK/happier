import { isActiveHomeAccountStatus } from '@happier-dev/protocol/home/governance';

import { isServerOwnerUserId, resolveServerOwnerUserIds } from "@/app/features/serverOwners";
import { db } from "@/storage/db";

export type LegacyServerDiagnosticsEntitlement =
    | Readonly<{ status: "allowed" }>
    | Readonly<{ status: "not_configured" }>
    | Readonly<{ status: "denied" }>;

/**
 * The narrow legacy entitlement for the environment-configured diagnostics
 * reader list.
 *
 * This is deliberately not a Home capability and must never be combined with
 * `Account.homeRole`: an environment-listed principal is a diagnostics reader,
 * not a Home owner, and folding it into Home authority would silently grant
 * Account deletion and Team governance. It is kept only so existing
 * deployments keep working, and it is removed once the supported operator
 * migration to a persisted Home role is established. It now additionally
 * requires the listed Account to be active, because an offboarded Account must
 * not keep reading server diagnostics.
 */
export async function resolveLegacyServerDiagnosticsEntitlement(input: Readonly<{
    env: NodeJS.ProcessEnv;
    accountId: string;
}>): Promise<LegacyServerDiagnosticsEntitlement> {
    if (resolveServerOwnerUserIds(input.env).length === 0) return { status: "not_configured" };
    if (!isServerOwnerUserId(input.env, input.accountId)) return { status: "denied" };
    const account = await db.account.findUnique({
        where: { id: input.accountId },
        select: { status: true },
    });
    if (!account) return { status: "denied" };
    return isActiveHomeAccountStatus(account.status) ? { status: "allowed" } : { status: "denied" };
}
