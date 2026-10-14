import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { VerifiedEphemeralSessionRunnerPrincipal } from "@happier-dev/protocol/ephemeralRunner/principal";
import { RunnerClaimV1Schema } from "@happier-dev/protocol/ephemeralRunner/endpoint";

import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { AccountStatus } from "@/storage/prisma";
import type { ActivationRow } from "./activationService";

export type MaterializedRunnerMachineRoutingBinding = Readonly<{
    accountId: string;
    sessionId: string;
}>;

/**
 * Resolves only the persisted address needed to discover an exact materialized
 * Runner Machine. This is not an authorization decision: the selected socket's
 * verified principal and the caller's Session capability are rechecked by the
 * forwarding guard immediately before the effect.
 */
export async function readMaterializedRunnerMachineRoutingBinding(
    machineId: string,
): Promise<MaterializedRunnerMachineRoutingBinding | null> {
    const activation = await db.ephemeralRunnerActivation.findFirst({
        where: { machineId, state: "materialized" },
        select: { creatorAccountId: true, sessionId: true },
    });
    return activation
        && typeof activation.creatorAccountId === "string"
        && typeof activation.sessionId === "string"
        ? { accountId: activation.creatorAccountId, sessionId: activation.sessionId }
        : null;
}

/**
 * Revalidates the complete persisted binding behind an already verified
 * Runner principal. Socket admission proves the signed bearer once; every
 * sensitive Machine operation uses this owner again so teardown, replacement,
 * or AccessKey revocation takes effect without waiting for reconnect.
 */
export async function verifyCurrentMaterializedRunnerPrincipalInTx(
    tx: Tx,
    principal: VerifiedEphemeralSessionRunnerPrincipal,
): Promise<VerifiedEphemeralSessionRunnerPrincipal | null> {
    const [account, activation, session, machine, accessKey] = await Promise.all([
        tx.account.findUnique({
            where: { id: principal.accountId },
            select: { status: true, tokenEpoch: true },
        }),
        tx.ephemeralRunnerActivation.findFirst({
            where: {
                id: principal.activationId,
                creatorAccountId: principal.accountId,
                creatorTokenEpoch: principal.creatorTokenEpoch,
                sessionId: principal.sessionId,
                machineId: principal.machineId,
                state: "materialized",
            },
            select: { id: true },
        }),
        tx.session.findFirst({
            where: { id: principal.sessionId, accountId: principal.accountId },
            select: { id: true },
        }),
        tx.machine.findFirst({
            where: {
                id: principal.machineId,
                accountId: principal.accountId,
                kind: "ephemeral_session_runner",
                installationId: principal.installationId,
                revokedAt: null,
                replacedByMachineId: null,
            },
            select: { installationPublicKey: true },
        }),
        tx.accessKey.findUnique({
            where: {
                accountId_machineId_sessionId: {
                    accountId: principal.accountId,
                    machineId: principal.machineId,
                    sessionId: principal.sessionId,
                },
            },
            select: { accountId: true },
        }),
    ]);
    if (
        !account
        || account.status !== AccountStatus.active
        || account.tokenEpoch !== principal.creatorTokenEpoch
        || !activation
        || !session
        || !machine?.installationPublicKey
        || !accessKey
    ) return null;
    return encodeBase64(machine.installationPublicKey, "base64url") === principal.installationPublicKey
        ? principal
        : null;
}

/** Resolves the current runtime tuple after the caller has verified its activation proof. */
export async function readCurrentMaterializedRunnerPrincipalForActivationInTx(
    tx: Tx,
    row: ActivationRow,
): Promise<VerifiedEphemeralSessionRunnerPrincipal | null> {
    if (row.state !== "materialized") return null;
    const claim = RunnerClaimV1Schema.safeParse(row.claim);
    if (!claim.success) return null;
    return verifyCurrentMaterializedRunnerPrincipalInTx(tx, {
        kind: "ephemeral_session_runner",
        authority: "session_runtime",
        accountId: row.creatorAccountId,
        activationId: row.id,
        sessionId: row.sessionId,
        machineId: row.machineId,
        installationId: claim.data.payload.installation.installationId,
        installationPublicKey: claim.data.payload.installation.publicKey,
        creatorTokenEpoch: row.creatorTokenEpoch,
    });
}

export async function verifyCurrentMaterializedRunnerPrincipal(
    principal: VerifiedEphemeralSessionRunnerPrincipal,
): Promise<VerifiedEphemeralSessionRunnerPrincipal | null> {
    return await verifyCurrentMaterializedRunnerPrincipalInTx(db, principal);
}
