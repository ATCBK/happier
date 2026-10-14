import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { ProviderBrokerOpenRequestV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import {
    RunnerActivationReviewV1Schema,
    type RunnerCredentialSelectionBindingV1,
} from "@happier-dev/protocol/ephemeralRunner/review";
import type { VerifiedEphemeralSessionRunnerPrincipal } from "@happier-dev/protocol/ephemeralRunner/principal";

import type { Tx } from "@/storage/inTx";
import { verifyCurrentMaterializedRunnerPrincipalInTx } from "./materializedRunnerPrincipalCurrentness";
import { StoredRunnerCredentialSelectionV1Schema } from "./credentialSelectionRecord";

/**
 * Resolves the exact broker Machine frozen before creator review for one
 * current restricted Runner. The public broker-open request intentionally has
 * no pin field: only the Home can recover this binding from the verified
 * activation principal and its server-owned selection record.
 */
export async function verifyRunnerBrokerOpenSelectionInTx(
    tx: Tx,
    input: Readonly<{
        principal: VerifiedEphemeralSessionRunnerPrincipal;
        request: ProviderBrokerOpenRequestV1;
    }>,
): Promise<RunnerCredentialSelectionBindingV1 | null> {
    if (!await verifyCurrentMaterializedRunnerPrincipalInTx(tx, input.principal)) return null;
    if (
        input.request.consumer.kind !== "session"
        || input.request.consumer.sessionId !== input.principal.sessionId
        || input.request.initiatorMachineId !== input.principal.machineId
    ) return null;

    const activation = await tx.ephemeralRunnerActivation.findUnique({
        where: { id: input.principal.activationId },
        select: { review: true, credentialSelection: true },
    });
    const review = RunnerActivationReviewV1Schema.safeParse(activation?.review);
    const stored = StoredRunnerCredentialSelectionV1Schema.safeParse(activation?.credentialSelection);
    if (
        !review.success
        || !stored.success
        || !pluginJsonValuesEqual(review.data.credentialSelectionBinding, stored.data.binding)
        || input.request.resourceId !== stored.data.request.selection.resourceId
        || input.request.expectedResourceRevision !== stored.data.request.selection.expectedResourceRevision
        || input.request.modelId !== stored.data.request.selection.modelId
        || input.request.sourceRevision !== stored.data.request.sourceRevision
        || !pluginJsonValuesEqual(input.request.application, stored.data.request.application)
    ) return null;

    return stored.data.binding;
}
