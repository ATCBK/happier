import { RunnerBrokerReadinessRequestV1Schema, verifyRunnerBrokerReadinessRequestV1, type RunnerBrokerReadinessRequestV1 } from '@happier-dev/protocol/ephemeralRunner/brokerReadinessRequestV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { RunnerActivationReviewV1Schema, type RunnerCredentialSelectionBindingV1 } from "@happier-dev/protocol/ephemeralRunner/review";
import { RunnerClaimV1Schema } from "@happier-dev/protocol/ephemeralRunner/endpoint";
import { verifyRunnerConsentV1 } from "@happier-dev/protocol/ephemeralRunner/consent";
import {
    verifyRunnerReadinessV1,
    type RunnerReadinessV1,
} from "@happier-dev/protocol/ephemeralRunner/readiness";
import type { AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';

import type { Tx } from "@/storage/inTx";
import { readRunnerCreatorCurrentnessInTx, reconcileRunnerActivationCurrentnessInTx } from "./activationCurrentness";
import { acquireRunnerActivationLockInTx } from './activationLock';
import { acquireAccountSessionOwnerMetadataFenceInTx, AccountSessionOwnerMetadataFenceAccountNotFoundError } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { runnerActivationBinding, type ActivationRow } from "./activationService";
import { readRunnerActivationAuthenticationEvidence } from "./activationAuthentication";
import { StoredRunnerCredentialSelectionV1Schema } from "./credentialSelectionRecord";

export type VerifiedRunnerBrokerReadinessCurrentness = Readonly<{
    request: RunnerBrokerReadinessRequestV1;
    creatorAccountId: string;
    resourceId: string;
    brokerMachineId: string;
    resourceRevision: number;
    credentialSelectionBinding: RunnerCredentialSelectionBindingV1;
    authenticationEvidence: readonly AuthTokenAuthenticationEvidenceV1[] | undefined;
}>;

/**
 * Revalidates the complete signed endpoint-readiness statement against the
 * immutable reviewed selection. Both readiness publication and final
 * materialization consume this owner so the latter cannot trust a stale or
 * partially corrupted persisted projection.
 */
export function verifyRunnerReadinessForActivation(
    row: ActivationRow,
    input: unknown,
): RunnerReadinessV1 | null {
    if (row.claim === null || row.review === null || row.consent === null) return null;
    const review = RunnerActivationReviewV1Schema.safeParse(row.review);
    const storedSelection = StoredRunnerCredentialSelectionV1Schema.safeParse(row.credentialSelection);
    if (
        !review.success
        || !storedSelection.success
        || !pluginJsonValuesEqual(storedSelection.data.binding, review.data.credentialSelectionBinding)
    ) return null;
    const readiness = verifyRunnerReadinessV1({
        readiness: input,
        claim: row.claim,
        expectedBinding: runnerActivationBinding(row),
        expectedLaunchManifestCommitment: review.data.launchManifestCommitment,
    });
    if (!readiness) return null;
    const installedAgentTargetKey = buildBackendTargetKeyV2(readiness.payload.installation.agentTarget);
    return installedAgentTargetKey === review.data.agentTargetKey
        && readiness.payload.brokerReadinessRequest.agentTargetKey === review.data.agentTargetKey
        && readiness.payload.brokerReadinessRequest.modelId === storedSelection.data.request.selection.modelId
        && pluginJsonValuesEqual(
            readiness.payload.credentialSelectionBinding,
            review.data.credentialSelectionBinding,
        )
        ? readiness
        : null;
}

/** Activation owner verification reused by broker admission and effect checks. */
export async function verifyRunnerBrokerReadinessCurrentnessInTx(
    tx: Tx,
    input: Readonly<{ activationId: string; request: unknown }>,
): Promise<VerifiedRunnerBrokerReadinessCurrentness | null> {
    const parsed = RunnerBrokerReadinessRequestV1Schema.safeParse(input.request);
    if (!parsed.success || parsed.data.activationId !== input.activationId) return null;
    const identity = await tx.ephemeralRunnerActivation.findUnique({ where: { id: input.activationId }, select: { creatorAccountId: true } });
    if (!identity) return null;
    try {
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, identity.creatorAccountId, 'content');
    } catch (error) {
        if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) return null;
        throw error;
    }
    await acquireRunnerActivationLockInTx(tx, input.activationId);
    const initial = await tx.ephemeralRunnerActivation.findUnique({ where: { id: input.activationId } });
    if (!initial) return null;
    const current = await readRunnerCreatorCurrentnessInTx(tx, initial.creatorAccountId);
    const row = await reconcileRunnerActivationCurrentnessInTx(tx, initial, current);
    if (current.status !== "ready" || row.state !== "consented") return null;
    const claim = RunnerClaimV1Schema.safeParse(row.claim);
    const review = RunnerActivationReviewV1Schema.safeParse(row.review);
    const storedSelection = StoredRunnerCredentialSelectionV1Schema.safeParse(row.credentialSelection);
    if (
        !claim.success
        || !review.success
        || !storedSelection.success
        || !pluginJsonValuesEqual(storedSelection.data.binding, review.data.credentialSelectionBinding)
        || row.consent === null
    ) return null;
    const consent = verifyRunnerConsentV1({
        consent: row.consent,
        claim: claim.data,
        expectedBinding: runnerActivationBinding(row),
        expectedLaunchManifestCommitment: review.data.launchManifestCommitment,
    });
    if (!consent) return null;
    if (
        parsed.data.agentTargetKey !== review.data.credentialSelectionBinding.application.agentTargetKey
        || parsed.data.modelId !== storedSelection.data.request.selection.modelId
        || parsed.data.protocol !== review.data.credentialSelectionBinding.application.protocol
    ) return null;
    const request = verifyRunnerBrokerReadinessRequestV1({
        request: parsed.data,
        claim: claim.data,
        expectedBinding: runnerActivationBinding(row),
        expectedFacts: {
            v: 1,
            kind: "provider_broker_readiness",
            homeServerIdentityId: row.homeServerIdentityId,
            activationId: row.id,
            launchManifestCommitment: review.data.launchManifestCommitment,
            resourceId: review.data.credentialSelectionBinding.resourceId,
            // The creator-reviewed target is the authority. A correctly dual-signed
            // Runner request must not be able to substitute another installed Agent.
            agentTargetKey: review.data.agentTargetKey,
            modelId: storedSelection.data.request.selection.modelId,
            protocol: review.data.credentialSelectionBinding.application.protocol,
            initiator: {
                installationId: claim.data.payload.installation.installationId,
                endpointId: parsed.data.initiator.endpointId,
            },
            target: {
                machineId: review.data.credentialSelectionBinding.brokerMachineId,
                endpointId: parsed.data.target.endpointId,
            },
        },
    });
    if (!request) return null;
    return {
        request,
        creatorAccountId: row.creatorAccountId,
        resourceId: review.data.credentialSelectionBinding.resourceId,
        brokerMachineId: review.data.credentialSelectionBinding.brokerMachineId,
        resourceRevision: review.data.credentialSelectionBinding.revision,
        credentialSelectionBinding: review.data.credentialSelectionBinding,
        authenticationEvidence: readRunnerActivationAuthenticationEvidence(row),
    };
}
