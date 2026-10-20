import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { verifyRunnerConsentV1, type RunnerConsentV1 } from "@happier-dev/protocol/ephemeralRunner/consent";
import { type RunnerReadinessV1 } from "@happier-dev/protocol/ephemeralRunner/readiness";
import { RunnerActivationReviewV1Schema, type RunnerActivationReviewV1 } from "@happier-dev/protocol/ephemeralRunner/review";
import { RunnerClaimV1Schema, RunnerEndpointFactsV1Schema } from "@happier-dev/protocol/ephemeralRunner/endpoint";
import { verifyRunnerMachineContentKeyBindingV1 } from "@happier-dev/protocol/ephemeralRunner/machineContentKeyBinding";
import {
    RunnerActivationProgressPhaseV1Schema,
    type RunnerActivationProgressPhaseV1,
} from "@happier-dev/protocol/ephemeralRunner/progress";
import {
    RunnerActivationProgressUpdateV1Schema,
    verifyRunnerActivationProgressUpdateV1,
    type RunnerActivationProgressUpdateV1,
} from "@happier-dev/protocol/ephemeralRunner/progressProof";

import {
    acquireAccountSessionOwnerMetadataFenceInTx,
    AccountSessionOwnerMetadataFenceAccountNotFoundError,
} from "@/app/encryption/accountSessionOwnerMetadataFence";
import { inTx, type Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { publishRunnerActivationChangedInTx } from "./activationChanges";
import {
    readRunnerCreatorCurrentnessInTx,
    reconcileRunnerActivationCurrentnessInTx,
} from "./activationCurrentness";
import {
    projectRunnerActivation,
    runnerActivationBinding,
    type ActivationRow,
} from "./activationService";
import { verifyRunnerReadinessForActivation } from "./runnerBrokerReadinessVerification";
import { StoredRunnerCredentialSelectionV1Schema } from "./credentialSelectionRecord";
import { readRunnerConsentDisplayFactsInTx } from "./runnerConsentDisplayFacts";
import { readCurrentMaterializedRunnerPrincipalForActivationInTx } from "./materializedRunnerPrincipalCurrentness";
import { acquireRunnerActivationLockInTx } from './activationLock';

export type StoreRunnerActivationProgressResult<T> =
    | Readonly<{ status: "stored"; value: T }>
    | Readonly<{ status: "unavailable" | "conflict" | "invalid_proof" }>;

async function reviewMatchesCanonicalCredentialSelectionInTx(
    tx: Tx,
    row: ActivationRow,
    review: RunnerActivationReviewV1,
): Promise<boolean> {
    const endpointFacts = RunnerEndpointFactsV1Schema.safeParse(row.endpointFacts);
    if (!endpointFacts.success || !pluginJsonValuesEqual(review.endpointFactsProof, {
        activationSignature: endpointFacts.data.activationSignature,
        installationSignature: endpointFacts.data.installationSignature,
    })) return false;
    const stored = StoredRunnerCredentialSelectionV1Schema.safeParse(row.credentialSelection);
    if (!stored.success || !pluginJsonValuesEqual(stored.data.binding, review.credentialSelectionBinding)) return false;
    const displayFacts = await readRunnerConsentDisplayFactsInTx({
        tx,
        homeServerIdentityId: row.homeServerIdentityId,
        creatorAccountId: row.creatorAccountId,
        teamId: stored.data.request.selection.teamId,
    });
    return displayFacts !== null && pluginJsonValuesEqual(displayFacts, review.displayFacts);
}

async function withCurrentClaimedActivation<T>(
    activationId: string,
    action: (tx: Tx, row: ActivationRow) => Promise<T>,
): Promise<T | null> {
    const result = await inTx(async (tx) => {
        const initial = await tx.ephemeralRunnerActivation.findUnique({
            where: { id: activationId },
            select: { creatorAccountId: true },
        });
        if (!initial) return null;
        try {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, initial.creatorAccountId, "content");
        } catch (error) {
            if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) return null;
            throw error;
        }
        await acquireRunnerActivationLockInTx(tx, activationId);
        const row = await tx.ephemeralRunnerActivation.findUnique({ where: { id: activationId } });
        if (!row) return null;
        const current = await readRunnerCreatorCurrentnessInTx(tx, row.creatorAccountId);
        const reconciled = await reconcileRunnerActivationCurrentnessInTx(tx, row, current);
        if (reconciled.state === "closed" || current.status !== "ready") return null;
        return { value: await action(tx, reconciled) };
    });
    return result === null ? null : result.value;
}

function verifyProgressUpdateForRow(row: ActivationRow, update: unknown): RunnerActivationProgressUpdateV1 | null {
    const claim = RunnerClaimV1Schema.safeParse(row.claim);
    if (!claim.success) return null;
    const parsed = RunnerActivationProgressUpdateV1Schema.safeParse(update);
    if (!parsed.success) return null;
    return verifyRunnerActivationProgressUpdateV1({
        update,
        expectedPayload: {
            v: 1,
            purpose: "happier.ephemeral-session-runner.activation-progress",
            activationId: row.id,
            sessionId: row.sessionId,
            machineId: row.machineId,
            creatorTokenEpoch: row.creatorTokenEpoch,
            phase: parsed.data.payload.phase,
        },
        activationSigningPublicKey: row.activationSigningPublicKey,
        installationPublicKey: claim.data.payload.installation.publicKey,
    });
}

/** Persists the endpoint-authenticated creator phase without permitting regressions. */
export async function storeRunnerActivationPhase(params: Readonly<{
    activationId: string;
    update: unknown;
}>): Promise<StoreRunnerActivationProgressResult<RunnerActivationProgressPhaseV1>> {
    const preflight = await db.ephemeralRunnerActivation.findUnique({ where: { id: params.activationId } });
    if (!preflight || preflight.claim === null || preflight.state === "pending"
        || preflight.state === "closed" || preflight.state === "materialized") return { status: "unavailable" };
    if (!verifyProgressUpdateForRow(preflight, params.update)) return { status: "invalid_proof" };
    const result = await withCurrentClaimedActivation(params.activationId, async (tx, row) => {
        if (row.state === "materialized" || row.state === "closed") return { status: "unavailable" } as const;
        const update = verifyProgressUpdateForRow(row, params.update);
        if (!update) return { status: "invalid_proof" } as const;
        // The endpoint reports one phase, strictly between consent and
        // readiness, so there is no ordering to arbitrate: an unknown stored
        // value is the only conflict left.
        if (row.state !== "consented") return { status: "unavailable" } as const;
        const current = RunnerActivationProgressPhaseV1Schema.safeParse(row.progressPhase);
        if (row.progressPhase !== null && !current.success) return { status: "conflict" } as const;
        if (current.success) return { status: "stored", value: current.data } as const;
        await tx.ephemeralRunnerActivation.update({
            where: { id: row.id },
            data: { progressPhase: update.payload.phase },
        });
        await publishRunnerActivationChangedInTx(tx, { creatorAccountId: row.creatorAccountId });
        return { status: "stored", value: update.payload.phase } as const;
    });
    return result ?? { status: "unavailable" };
}

/** Freezes the creator-reviewed sealed manifest and exact broker selection. */
export async function storeRunnerActivationReview(params: Readonly<{
    creatorAccountId: string;
    activationId: string;
    review: RunnerActivationReviewV1;
}>): Promise<StoreRunnerActivationProgressResult<RunnerActivationReviewV1>> {
    const result = await withCurrentClaimedActivation(params.activationId, async (tx, row) => {
        if (row.creatorAccountId !== params.creatorAccountId || row.state !== "claimed" || row.endpointFacts === null) {
            return { status: "unavailable" } as const;
        }
        if (params.review.authoringCommitment !== row.authoringCommitment) {
            return { status: "invalid_proof" } as const;
        }
        if (row.review !== null) {
            const stored = StoredRunnerCredentialSelectionV1Schema.safeParse(row.credentialSelection);
            const existingReview = RunnerActivationReviewV1Schema.safeParse(row.review);
            if (!stored.success || !existingReview.success
                || existingReview.data.authoringCommitment !== row.authoringCommitment
                || !pluginJsonValuesEqual(stored.data.binding, existingReview.data.credentialSelectionBinding)) {
                return { status: "invalid_proof" } as const;
            }
            return pluginJsonValuesEqual(row.review, params.review)
                ? { status: "stored", value: params.review } as const
                : { status: "conflict" } as const;
        }
        if (!await reviewMatchesCanonicalCredentialSelectionInTx(tx, row, params.review)) {
            return { status: "invalid_proof" } as const;
        }
        const activationBinding = runnerActivationBinding(row);
        if (activationBinding.endpointFactsRecipient.mode === "plain") {
            if (params.review.machineContentKeyBinding !== null) return { status: "invalid_proof" } as const;
        } else {
            const claim = RunnerClaimV1Schema.safeParse(row.claim);
            const machineBinding = params.review.machineContentKeyBinding;
            if (!claim.success || machineBinding === null || !verifyRunnerMachineContentKeyBindingV1({
                binding: machineBinding,
                expectedPayload: {
                    v: 1,
                    purpose: "happier.ephemeral-runner.machine-content-key",
                    homeServerIdentityId: row.homeServerIdentityId,
                    activationId: row.id,
                    creatorAccountId: row.creatorAccountId,
                    machineId: row.machineId,
                    installationId: claim.data.payload.installation.installationId,
                    machineContentKeyFingerprint: machineBinding.machineContentKeyFingerprint,
                },
                // The creator-generated activation signing identity is the proof
                // root, so a DataKey or token-only creator needs no Account
                // signing authority. The public half is the value this Home
                // recorded at activation creation, not a submitted field.
                expectedAccountSigningPublicKey: row.activationSigningPublicKey,
            })) return { status: "invalid_proof" } as const;
        }
        await tx.ephemeralRunnerActivation.update({ where: { id: row.id }, data: { review: params.review } });
        return { status: "stored", value: params.review } as const;
    });
    return result ?? { status: "unavailable" };
}

/** Stores affirmative dual-key consent for exactly the frozen review. */
export async function storeRunnerActivationConsent(params: Readonly<{
    activationId: string;
    consent: unknown;
}>): Promise<StoreRunnerActivationProgressResult<RunnerConsentV1>> {
    const preflight = await db.ephemeralRunnerActivation.findUnique({ where: { id: params.activationId } });
    if (!preflight || preflight.claim === null || preflight.review === null) return { status: "unavailable" };
    const preflightReview = RunnerActivationReviewV1Schema.safeParse(preflight.review);
    if (!preflightReview.success || !verifyRunnerConsentV1({
        consent: params.consent,
        claim: preflight.claim,
        expectedBinding: runnerActivationBinding(preflight),
        expectedLaunchManifestCommitment: preflightReview.data.launchManifestCommitment,
    })) return { status: "invalid_proof" };
    const result = await withCurrentClaimedActivation(params.activationId, async (tx, row) => {
        if ((row.state !== "claimed" && row.state !== "consented") || row.review === null || row.claim === null) {
            return { status: "unavailable" } as const;
        }
        const review = RunnerActivationReviewV1Schema.safeParse(row.review);
        if (!review.success) return { status: "invalid_proof" } as const;
        const consent = verifyRunnerConsentV1({
            consent: params.consent,
            claim: row.claim,
            expectedBinding: runnerActivationBinding(row),
            expectedLaunchManifestCommitment: review.data.launchManifestCommitment,
        });
        if (!consent) return { status: "invalid_proof" } as const;
        if (row.consent !== null) {
            return pluginJsonValuesEqual(row.consent, consent)
                ? { status: "stored", value: consent } as const
                : { status: "conflict" } as const;
        }
        await tx.ephemeralRunnerActivation.update({
            where: { id: row.id },
            data: { state: "consented", consent },
        });
        await publishRunnerActivationChangedInTx(tx, { creatorAccountId: row.creatorAccountId });
        return { status: "stored", value: consent } as const;
    });
    return result ?? { status: "unavailable" };
}

/** Records endpoint readiness only after review and consent are immutable. */
export async function storeRunnerActivationReadiness(params: Readonly<{
    activationId: string;
    readiness: unknown;
}>): Promise<StoreRunnerActivationProgressResult<RunnerReadinessV1>> {
    const preflight = await db.ephemeralRunnerActivation.findUnique({ where: { id: params.activationId } });
    if (!preflight) return { status: "unavailable" };
    if (!verifyRunnerReadinessForActivation(preflight, params.readiness)) return { status: "invalid_proof" };
    const result = await withCurrentClaimedActivation(params.activationId, async (tx, row) => {
        if (row.state !== "consented" && row.state !== "materialized") return { status: "unavailable" } as const;
        const readiness = verifyRunnerReadinessForActivation(row, params.readiness);
        if (!readiness) return { status: "invalid_proof" } as const;
        // A committed readiness response can be lost while the creator uses
        // that readiness to materialize. Acknowledge only the exact recorded
        // proof and still-current tuple; this never admits another readiness
        // operation or reopens the pre-materialization broker authority.
        if (row.state === "materialized") {
            if (!await readCurrentMaterializedRunnerPrincipalForActivationInTx(tx, row)) {
                return { status: "unavailable" } as const;
            }
            return pluginJsonValuesEqual(row.readiness, readiness)
                ? { status: "stored", value: readiness } as const
                : { status: "conflict" } as const;
        }
        if (row.readiness !== null) {
            return pluginJsonValuesEqual(row.readiness, readiness)
                ? { status: "stored", value: readiness } as const
                : { status: "conflict" } as const;
        }
        await tx.ephemeralRunnerActivation.update({ where: { id: row.id }, data: { readiness } });
        await publishRunnerActivationChangedInTx(tx, { creatorAccountId: row.creatorAccountId });
        return { status: "stored", value: readiness } as const;
    });
    return result ?? { status: "unavailable" };
}
