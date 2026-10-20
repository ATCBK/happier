import type { Metadata } from '@happier-dev/session-core/state';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import {
    readActiveSessionModelSelectionFromMetadata,
    readSessionModelSelectionV2FromMetadata,
} from '@happier-dev/agents';
import { readSessionModelSelectionIntentFromMetadata } from '@/sync/domains/models/readSessionModelSelectionIntent';
import { readSessionProviderBindingMetadataStateV1, sessionProviderBindingMetadataMatchesRuntimeBasisV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import type { ProviderBoundModelRef, SessionModelSelectionIntentV1 } from '@happier-dev/protocol/providers/model-selection';
import type { SessionModelSelectionV2 } from '@happier-dev/protocol/providers/selection/v2';

export type CurrentSessionRunnerProcessIdentity = Readonly<{
    pid: number;
    processStartTimeMs: number;
}>;

export type SessionModelSelectionDisposition = Readonly<{
    sessionDisposition: 'active' | 'next_launch';
    proposedIntent: SessionModelSelectionIntentV1 | null;
    proposedSelection: ProviderBoundModelRef | null;
    proposedSelectionV2: SessionModelSelectionV2 | null;
    activeSelection: ProviderBoundModelRef | null;
    /** Coherent runtime-applied history for presentation; never current runner/context authority. */
    lastAppliedSelection: ProviderBoundModelRef | null;
    selectionTransitionPending: boolean;
    reportedSelection: ProviderBoundModelRef | null;
    reportedSelectionStatus: 'running' | 'last_used' | 'last_reported' | null;
    contextSelection: ProviderBoundModelRef | null;
}>;

function normalizeModelId(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Projects proposed, exact-active, and presentation-only model facts without
 * promoting fallback catalog state into active runtime truth.
 */
export function resolveSessionModelSelectionDisposition(params: Readonly<{
    agentId: string;
    agentTargetKey: string;
    metadata: Metadata | null | undefined;
    sessionActive: boolean;
    currentRunnerProcessIdentity: CurrentSessionRunnerProcessIdentity | null;
}>): SessionModelSelectionDisposition {
    let proposedIntent: SessionModelSelectionIntentV1 | null = null;
    const proposedSelectionV2 = readSessionModelSelectionV2FromMetadata(params.metadata);
    try {
        proposedIntent = readSessionModelSelectionIntentFromMetadata(
            params.metadata,
            params.agentTargetKey,
        );
    } catch {
        proposedIntent = null;
    }
    const proposedSelection = proposedSelectionV2
        ? proposedSelectionV2.ref.source === 'team_resource'
            ? null
            : {
                agentTargetKey: proposedSelectionV2.ref.agentTargetKey,
                providerConnectionId: proposedSelectionV2.ref.source === 'native'
                    ? null
                    : proposedSelectionV2.ref.providerConnectionId,
                modelId: proposedSelectionV2.ref.modelId,
            }
        : proposedIntent?.selection ?? null;

    const providerBindingState = readSessionProviderBindingMetadataStateV1(params.metadata);
    const exactSelection = readActiveSessionModelSelectionFromMetadata(
        params.metadata,
        params.agentId,
        params.agentTargetKey,
        params.currentRunnerProcessIdentity,
    );

    const sessionModels = readSessionModelsState(params.metadata);
    const fallbackModelId = sessionModels?.agentId === params.agentId
        ? normalizeModelId(sessionModels.currentModelId)
        : '';
    const nativeFallbackSelection: ProviderBoundModelRef = {
        agentTargetKey: params.agentTargetKey,
        providerConnectionId: null,
        modelId: fallbackModelId,
    };
    const providerFallbackSelection: ProviderBoundModelRef | null =
        providerBindingState.kind === 'valid'
        && providerBindingState.binding.model?.id === fallbackModelId
        && sessionProviderBindingMetadataMatchesRuntimeBasisV1({
            selection: {
                agentTargetKey: params.agentTargetKey,
                providerConnectionId: providerBindingState.binding.connectionId,
            },
            binding: providerBindingState.binding,
        })
            ? {
                agentTargetKey: params.agentTargetKey,
                providerConnectionId: providerBindingState.binding.connectionId,
                modelId: fallbackModelId,
            }
            : null;
    const fallbackSelection: ProviderBoundModelRef | null = !fallbackModelId
        ? null
        : providerBindingState.kind === 'absent'
            ? nativeFallbackSelection
            : providerFallbackSelection;
    const reportedSelection = exactSelection ?? fallbackSelection;
    const activeSelection = params.sessionActive ? exactSelection : null;
    // A replacement runner is not a new model choice. Compare intent with
    // coherent applied history even while the replacement's model publication
    // is catching up. This history never supplies active/context authority;
    // a genuinely different selection still requires transition admission.
    const lastAppliedSelection = exactSelection ?? readActiveSessionModelSelectionFromMetadata(
        params.metadata,
        params.agentId,
        params.agentTargetKey,
        params.metadata?.sessionModelsV1?.activeSelectionV1?.runner ?? null,
    );
    const teamSelectionTransitionPending = proposedSelectionV2?.ref.source === 'team_resource'
        && (
            params.currentRunnerProcessIdentity === null
            || params.currentRunnerProcessIdentity.processStartTimeMs <= proposedSelectionV2.updatedAt
        );
    const selectionTransitionPending = params.sessionActive
        && (
            teamSelectionTransitionPending
            || (
                proposedIntent !== null
                // Session socket presence precedes native startup/model publication.
                // The launch intent alone is not evidence of a changed runtime route.
                // Leave active/context authority unknown until the producer publishes it.
                && sessionModels !== null
                && (
                    lastAppliedSelection === null
                    || proposedSelection === null
                    || lastAppliedSelection.agentTargetKey !== proposedSelection.agentTargetKey
                    || lastAppliedSelection.providerConnectionId !== proposedSelection.providerConnectionId
                    || lastAppliedSelection.modelId !== proposedSelection.modelId
                )
            )
        );
    const reportedSelectionStatus = reportedSelection === null
        ? null
        : exactSelection !== null
            ? params.sessionActive ? 'running' : 'last_used'
            : 'last_reported';

    return {
        sessionDisposition: params.sessionActive ? 'active' : 'next_launch',
        proposedIntent,
        proposedSelection,
        proposedSelectionV2,
        activeSelection,
        lastAppliedSelection,
        selectionTransitionPending,
        reportedSelection,
        reportedSelectionStatus,
        contextSelection: params.sessionActive
            ? activeSelection
            : proposedSelection ?? reportedSelection,
    };
}
