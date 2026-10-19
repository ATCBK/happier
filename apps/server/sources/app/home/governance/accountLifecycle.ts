import type { AccountStatusV1 } from '@happier-dev/protocol/home/governance';
import { afterTx, type Tx } from "@/storage/inTx";
import { auth } from "@/app/auth/auth";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { eventRouter } from "@/app/events/connectionEventRouter";
import {
    applySessionAccessAccountStatusImpactInTx,
    captureSessionAccessAccountStatusImpactInTx,
    acquireSessionAccountStatusCursorLocksInTx,
} from "@/app/session/access/sessionAccessAccountStatusImpact";
import { publishAccountTeamMembershipsChangedInTx, readAccountTeamMembershipsChangeAudienceInTx } from "@/app/teams/teamChanges";
import {
    acquireAccountSessionOwnerMetadataFenceInTx,
    AccountSessionOwnerMetadataFenceAccountNotFoundError,
} from "@/app/encryption/accountSessionOwnerMetadataFence";
import {
    authorizeHomeGovernanceMutationInTx,
    assertHomeOwnershipSurvivesTransitionInTx,
    readHomeGovernanceAccountInTx,
} from "./homeCapabilities";
import { recordHomeAdministrationEventInTx } from "@/app/home/audit/homeAdministrationEvents";
import { publishHomeGovernanceChangedInTx, readHomeGovernanceChangeAccountIdsInTx } from "./governanceChanges";

/** Admit the complete lifecycle projection audience before its resource writes. */
export async function acquireAccountLifecycleAdmissionInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; additionalAccountIds?: readonly string[] }>,
): Promise<void> {
    const [homeAudience, teamAudience] = await Promise.all([
        readHomeGovernanceChangeAccountIdsInTx(tx),
        readAccountTeamMembershipsChangeAudienceInTx(tx, { accountId: input.accountId }),
    ]);
    await acquireSessionAccountStatusCursorLocksInTx(tx, {
        accountId: input.accountId,
        additionalAccountIds: [input.accountId, ...(input.additionalAccountIds ?? []), ...homeAudience, ...teamAudience],
        intent: "exclusive",
    });
}

export type AccountLifecycleInput = Readonly<{
    actorAccountId: string;
    targetAccountId: string;
    status: AccountStatusV1;
    authority: "home_administration" | "provider_account_replacement" | "account_erasure";
}>;

export type AccountLifecycleResult =
    | Readonly<{ status: "applied" | "unchanged" }>
    | Readonly<{ status: "rejected"; code:
        | "home_governance_forbidden"
        | "home_account_not_found"
        | "home_account_inactive"
        | "home_owner_transfer_required" }>;

/**
 * Changes lifecycle and revokes credentials in the caller's serializable
 * transaction. The shared Account fence is deliberately key-neutral: security
 * offboarding must remain possible when encryption material is inconsistent.
 * Trusted replacement/erasure callers establish their own admission before
 * entering this primitive; authority is never supplied by a transport body.
 */
export async function setAccountStatusInTx(tx: Tx, input: AccountLifecycleInput): Promise<AccountLifecycleResult> {
    const accountIds = [...new Set([input.actorAccountId, input.targetAccountId])].sort();
    await acquireAccountLifecycleAdmissionInTx(tx, {
        accountId: input.targetAccountId,
        additionalAccountIds: accountIds,
    });
    for (const accountId of accountIds) {
        try {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, accountId, "exclusive");
        } catch (error) {
            if (!(error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError)) throw error;
            return { status: "rejected", code: accountId === input.actorAccountId
                ? "home_governance_forbidden" : "home_account_not_found" };
        }
    }
    if (input.authority === "home_administration") {
        const admission = await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: input.actorAccountId,
            request: { operation: "set_account_status", targetAccountId: input.targetAccountId, nextStatus: input.status },
        });
        if (admission.status === "rejected") return admission;
        if (input.status === "disabled") return { status: "rejected", code: "home_governance_forbidden" };
    }
    const target = await readHomeGovernanceAccountInTx(tx, input.targetAccountId);
    if (!target) return { status: "rejected", code: "home_account_not_found" };
    if (target.status === input.status) return { status: "unchanged" };
    if (target.status === "disabled") return { status: "rejected", code: "home_account_inactive" };
    const ownership = await assertHomeOwnershipSurvivesTransitionInTx(tx, {
        targetAccountId: input.targetAccountId, nextStatus: input.status,
    });
    if (ownership.status === "rejected") return ownership;
    if (ownership.status === "target_not_found") return { status: "rejected", code: "home_account_not_found" };
    const sessionAccessImpact = await captureSessionAccessAccountStatusImpactInTx(tx, {
        accountId: target.accountId,
    });
    await tx.account.update({ where: { id: target.accountId }, data: { status: input.status } });
    await applySessionAccessAccountStatusImpactInTx(tx, { impact: sessionAccessImpact });
    if (input.authority === "home_administration") {
        await recordHomeAdministrationEventInTx(tx, {
            actor: { kind: "account", accountId: input.actorAccountId },
            target: { kind: "account", id: target.accountId },
            detail: { action: "account.status.set", summary: { from: target.status, to: input.status } },
        });
    }
    if (target.status === "active") await auth.revokeAllAccountCredentialsInTx(tx, target.accountId);
    await markAccountChanged(tx, { accountId: target.accountId, kind: "account", entityId: "self" });
    await publishHomeGovernanceChangedInTx(tx, {
        // The target's own cursor was advanced by the canonical Account
        // lifecycle projection immediately above. Remaining administrators
        // need the Home governance wake so People and policy eligibility do
        // not retain the old lifecycle row after this transaction commits.
        excludeAccountIds: [target.accountId],
    });
    await publishAccountTeamMembershipsChangedInTx(tx, {
        accountId: target.accountId,
        // The target's own cursor was advanced by the canonical Account
        // lifecycle projection immediately above. Other Team members and Home
        // administrators still need the Team-directory wake.
        excludeAccountIds: [target.accountId],
    });
    if (input.status !== "active") afterTx(tx, () => eventRouter.disconnectAccountSockets(target.accountId));
    return { status: "applied" };
}
