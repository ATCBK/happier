import {
    RunnerEndpointProjectionRequestV1Schema,
    verifyRunnerEndpointProjectionProofV1,
    type RunnerEndpointProjectionResponseV1,
} from "@happier-dev/protocol/ephemeralRunner/endpointProjection";
import { RunnerClaimV1Schema } from "@happier-dev/protocol/ephemeralRunner/endpoint";
import { RunnerActivationReviewV1Schema } from "@happier-dev/protocol/ephemeralRunner/review";

import { auth } from "@/app/auth/auth";
import {
    acquireAccountSessionOwnerMetadataFenceInTx,
    AccountSessionOwnerMetadataFenceAccountNotFoundError,
} from "@/app/encryption/accountSessionOwnerMetadataFence";
import { db } from "@/storage/db";
import { acquireRunnerActivationLockInTx } from './activationLock';
import { inTx } from "@/storage/inTx";
import {
    readRunnerCreatorCurrentnessInTx,
    reconcileRunnerActivationCurrentnessInTx,
} from "./activationCurrentness";
import { projectRunnerActivation, type ActivationRow } from "./activationService";
import { readStoredRunnerBootstrap } from "./materializeEphemeralRunner";
import { readRunnerBrokerReadinessProjectionInTx } from "@/app/teams/credentials/runnerBrokerReadinessAuthorization";
import { readCurrentMaterializedRunnerPrincipalForActivationInTx } from "./materializedRunnerPrincipalCurrentness";
import { readRunnerActivationAuthenticationEvidence } from "./activationAuthentication";
import { resolveCurrentAuthenticationEvidenceInTx } from "@/app/auth/authenticationEvidence";

/**
 * The endpoint learns the reviewed launch-manifest commitment only by opening the
 * sealed manifest carried inside the review disclosure itself, so the poll that
 * discovers a freshly published review necessarily carries none. Review discovery
 * therefore accepts the stored commitment *or* none; from the endpoint's own
 * consent onwards it knows the commitment, so every later disclosure — readiness,
 * the materialized bootstrap and the runtime token — keeps requiring the exact
 * stored value. The proof itself stays dual-signed by the activation and
 * installation keys in every phase.
 */
function expectedProofPayloads(row: ActivationRow) {
    const review = row.review === null ? null : RunnerActivationReviewV1Schema.safeParse(row.review);
    const stored = review === null || !review.success ? null : review.data.launchManifestCommitment;
    const commitments = stored === null || row.consent !== null ? [stored] : [stored, null];
    return commitments.map((launchManifestCommitment) => ({
        v: 1 as const,
        purpose: "happier.ephemeral-session-runner.endpoint-projection" as const,
        activationId: row.id,
        sessionId: row.sessionId,
        machineId: row.machineId,
        launchManifestCommitment,
        creatorTokenEpoch: row.creatorTokenEpoch,
    }));
}

export function verifyRunnerEndpointProjectionProofAgainstRow(row: ActivationRow, request: unknown) {
    const claim = RunnerClaimV1Schema.safeParse(row.claim);
    if (!claim.success) return null;
    for (const expectedPayload of expectedProofPayloads(row)) {
        const verified = verifyRunnerEndpointProjectionProofV1({
            request,
            expectedPayload,
            activationSigningPublicKey: row.activationSigningPublicKey,
            installationPublicKey: claim.data.payload.installation.publicKey,
        });
        if (verified !== null) return verified;
    }
    return null;
}

/**
 * Proof-bound endpoint read. The cheap signature check intentionally precedes
 * the creator Account fence; the same proof and every authority fact are then
 * reread under that fence before projection or credential issuance.
 */
export async function readEphemeralRunnerEndpointProjection(params: Readonly<{
    activationId: string;
    request: unknown;
}>): Promise<RunnerEndpointProjectionResponseV1> {
    const request = RunnerEndpointProjectionRequestV1Schema.safeParse(params.request);
    if (!request.success || request.data.payload.activationId !== params.activationId) {
        return { status: "conflict", reason: "proof_mismatch" };
    }
    const preflight = await db.ephemeralRunnerActivation.findUnique({ where: { id: params.activationId } });
    if (!preflight || !verifyRunnerEndpointProjectionProofAgainstRow(preflight, request.data)) {
        return { status: "conflict", reason: "proof_mismatch" };
    }

    return inTx(async (tx): Promise<RunnerEndpointProjectionResponseV1> => {
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, preflight.creatorAccountId, "content");
        await acquireRunnerActivationLockInTx(tx, params.activationId);
        const initial = await tx.ephemeralRunnerActivation.findUnique({ where: { id: params.activationId } });
        if (!initial || initial.creatorAccountId !== preflight.creatorAccountId) {
            return { status: "conflict", reason: "proof_mismatch" };
        }
        const current = await readRunnerCreatorCurrentnessInTx(tx, initial.creatorAccountId);
        const row = await reconcileRunnerActivationCurrentnessInTx(tx, initial, current);
        if (!verifyRunnerEndpointProjectionProofAgainstRow(row, request.data)) return { status: "conflict", reason: "proof_mismatch" };
        if (row.state === "closed") {
            return { status: "unavailable", reason: row.closeReason === "expired" ? "activation_expired" : "activation_closed" };
        }
        if (current.status !== "ready") return { status: "unavailable", reason: current.status };
        const activation = projectRunnerActivation(row, current);
        if (row.state !== "materialized") {
            const review = RunnerActivationReviewV1Schema.safeParse(row.review);
            const brokerReadiness = review.success
                ? await readRunnerBrokerReadinessProjectionInTx(tx, {
                    activationId: row.id,
                    selection: review.data.credentialSelectionBinding,
                })
                : null;
            return { status: "pending", activation, brokerReadiness };
        }

        const bootstrap = readStoredRunnerBootstrap(row.sealedBootstrap);
        if (bootstrap === null) {
            return { status: "unavailable", reason: "not_materialized" };
        }
        const principal = await readCurrentMaterializedRunnerPrincipalForActivationInTx(tx, row);
        if (principal === null) {
            return { status: "unavailable", reason: "not_materialized" };
        }
        const storedAuthenticationEvidence = readRunnerActivationAuthenticationEvidence(row);
        const authenticationEvidence = await resolveCurrentAuthenticationEvidenceInTx(tx, {
            env: process.env,
            accountId: row.creatorAccountId,
            evidence: storedAuthenticationEvidence,
        });
        const runtimeToken = await auth.createTokenInTx(
            tx,
            row.creatorAccountId,
            { ephemeralSessionRunnerPrincipal: principal },
            {
                kind: "ephemeral_session_runner",
                authority: "session_runtime",
                ...(authenticationEvidence.length > 0 ? { authenticationEvidence } : {}),
            },
        );
        return { status: "materialized", activation, runtimeToken, sealedBootstrap: bootstrap.content };
    }, {
        // Runtime-token disclosure combines creator and foreign broker/authentication currentness.
        isolationLevel: "Serializable",
    }).catch((error: unknown) => {
        if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) {
            return { status: "unavailable", reason: "creator_unavailable" };
        }
        throw error;
    });
}
