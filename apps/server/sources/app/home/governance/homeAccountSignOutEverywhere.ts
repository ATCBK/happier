import type { HomeAccountRowV1 } from '@happier-dev/protocol/home/governance';

import { auth } from "@/app/auth/auth";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { recordHomeAdministrationEventInTx } from "@/app/home/audit/homeAdministrationEvents";
import { afterTx, type Tx } from "@/storage/inTx";

import { authorizeHomeGovernanceMutationInTx } from "./homeCapabilities";
import { readHomeAccountRowInTx, type HomeGovernanceResult } from "./homeGovernanceService";

/**
 * An administrator ends every signed-in session of another Account (plan §3.12, D-9).
 *
 * The Home's one authorization owner decides who may (account administration; owner authority for
 * an owner Account), reread in this transaction. Only an active Account has sessions to end. The
 * session owner bumps the Account's token epoch, so every signed session is refused on its next
 * request; API tokens are separate automation credentials and stay valid until the Account is
 * disabled. No role or status changes, so ownership continuity is not involved. The change is
 * audited with its actor, and the person's live sockets are closed once it commits.
 */
export async function signOutHomeAccountEverywhereInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    targetAccountId: string;
    env: NodeJS.ProcessEnv;
    emailDeliveryReady: boolean;
}>): Promise<HomeGovernanceResult<HomeAccountRowV1>> {
    const admission = await authorizeHomeGovernanceMutationInTx(tx, {
        actorAccountId: input.actorAccountId,
        request: { operation: "sign_out_account_everywhere", targetAccountId: input.targetAccountId },
    });
    if (admission.status === "rejected") return { status: "rejected", code: admission.code };
    const target = admission.target;
    if (!target) return { status: "rejected", code: "home_account_not_found" };
    if (target.status !== "active") return { status: "rejected", code: "home_account_inactive" };

    await auth.signOutEverywhereInTx(tx, target.accountId);
    await recordHomeAdministrationEventInTx(tx, {
        actor: { kind: "account", accountId: input.actorAccountId },
        target: { kind: "account", id: target.accountId },
        detail: { action: "account.sign_out_everywhere", summary: {} },
    });
    afterTx(tx, () => eventRouter.disconnectAccountSockets(target.accountId));

    const account = await readHomeAccountRowInTx(tx, {
        actorAccountId: input.actorAccountId,
        accountId: target.accountId,
        env: input.env,
        emailDeliveryReady: input.emailDeliveryReady,
    });
    return account
        ? { status: "ok", result: account }
        : { status: "rejected", code: "home_account_not_found" };
}
