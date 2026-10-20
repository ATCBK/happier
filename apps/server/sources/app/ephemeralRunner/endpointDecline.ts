import { RunnerEndpointProjectionRequestV1Schema, type RunnerEndpointDeclineResponseV1 } from "@happier-dev/protocol/ephemeralRunner/endpointProjection";

import {
    acquireAccountSessionOwnerMetadataFenceInTx,
    AccountSessionOwnerMetadataFenceAccountNotFoundError,
} from "@/app/encryption/accountSessionOwnerMetadataFence";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { publishRunnerActivationChangedInTx } from "./activationChanges";
import { readRunnerCreatorCurrentnessInTx, reconcileRunnerActivationCurrentnessInTx } from "./activationCurrentness";
import { closeEphemeralRunnerActivationInTx } from "./activationLifecycle";
import { verifyRunnerEndpointProjectionProofAgainstRow } from "./endpointProjection";
import { acquireRunnerActivationLockInTx } from './activationLock';

export type DeclineEphemeralRunnerActivationResult = RunnerEndpointDeclineResponseV1;

/** Proof-bound endpoint decline, sharing the activation lifecycle transition owner. */
export async function declineEphemeralRunnerActivationByEndpoint(params: Readonly<{
    activationId: string;
    request: unknown;
}>): Promise<DeclineEphemeralRunnerActivationResult> {
    const request = RunnerEndpointProjectionRequestV1Schema.safeParse(params.request);
    if (!request.success || request.data.payload.activationId !== params.activationId) {
        return { status: "conflict", reason: "proof_mismatch" };
    }
    const preflight = await db.ephemeralRunnerActivation.findUnique({ where: { id: params.activationId } });
    if (!preflight || !verifyRunnerEndpointProjectionProofAgainstRow(preflight, request.data)) {
        return { status: "conflict", reason: "proof_mismatch" };
    }
    return inTx(async (tx): Promise<DeclineEphemeralRunnerActivationResult> => {
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, preflight.creatorAccountId, "content");
        await acquireRunnerActivationLockInTx(tx, params.activationId);
        const initial = await tx.ephemeralRunnerActivation.findUnique({ where: { id: params.activationId } });
        if (!initial || !verifyRunnerEndpointProjectionProofAgainstRow(initial, request.data)) {
            return { status: "conflict", reason: "proof_mismatch" };
        }
        const current = await readRunnerCreatorCurrentnessInTx(tx, initial.creatorAccountId);
        const row = await reconcileRunnerActivationCurrentnessInTx(tx, initial, current);
        if (!verifyRunnerEndpointProjectionProofAgainstRow(row, request.data)) {
            return { status: "conflict", reason: "proof_mismatch" };
        }
        if (row.state === "closed") {
            if (row.closeReason === "declined") return { status: "declined" };
            return { status: "unavailable", reason: row.closeReason === "expired" ? "activation_expired" : "activation_closed" };
        }
        if (current.status !== "ready") return { status: "unavailable", reason: current.status };
        if (row.state === "materialized") return { status: "unavailable", reason: "already_materialized" };
        await closeEphemeralRunnerActivationInTx(tx, {
            activationId: row.id,
            creatorAccountId: row.creatorAccountId,
            reason: "declined",
        });
        await publishRunnerActivationChangedInTx(tx, { creatorAccountId: row.creatorAccountId });
        return { status: "declined" };
    }).catch((error: unknown) => {
        if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) {
            return { status: "unavailable", reason: "creator_unavailable" };
        }
        throw error;
    });
}
