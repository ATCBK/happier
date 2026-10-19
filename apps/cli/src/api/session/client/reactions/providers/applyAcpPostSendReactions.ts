import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';
import type { SessionTranscriptObservationProvenanceV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';

import type {
    ACPMessageData,
    ACPProvider,
} from '../../../sessionMessageTypes';
import {
    resolveUsageObservationExternalKey,
} from '../../../outbound/shared';
import {
    publishTokenCountUsageObservation,
} from '../usagePublishing';
import type { PostSendReactionPort } from './postSendReactionPort';

type AcpPermissionRequest = Extract<ACPMessageData, { type: 'permission-request' }>;

function mirrorPublishedPermissionRequest(
    port: PostSendReactionPort,
    params: Readonly<{
        provider: ACPProvider;
        body: AcpPermissionRequest;
        createdAt: number;
    }>,
): void {
    const store = port.getAgentStateRequestStore?.();
    if (!store) throw new Error('ACP permission publication requires the bound AgentStateRequestStore');
    store.publishMirroredRequest({
        requestId: params.body.permissionId,
        toolName: params.body.toolName,
        toolInput: params.body.options ?? {},
        createdAt: params.createdAt,
        kind: resolveAgentRequestKind(params.body.toolName),
        source: params.provider,
        ...(params.body.sidechainId ? { sidechainId: params.body.sidechainId } : {}),
    });
}

export function applyAcpPostSendReactions(
    port: PostSendReactionPort,
    params: Readonly<{
        provider: ACPProvider;
        normalizedBody: ACPMessageData;
        localId: string;
        createdAt: number;
        provenance: SessionTranscriptObservationProvenanceV1;
    }>,
): void {
    if (params.normalizedBody.type === 'permission-request'
        && params.provenance.source !== 'history' && params.provenance.source !== 'sidechain') {
        mirrorPublishedPermissionRequest(port, {
            provider: params.provider,
            body: params.normalizedBody,
            createdAt: params.createdAt,
        });
    }

    if (params.normalizedBody.type !== 'token_count') {
        return;
    }

    void publishTokenCountUsageObservation({
        sessionId: port.sessionId,
        publisher: port.usageObservationPublisher,
        provider: params.provider,
        body: params.normalizedBody,
        // The normalized token-count shape is shared by several native
        // transports. Its provider/source fields preserve the useful usage
        // observation without guessing at an Agent-owned runtime mode.
        backendMode: null,
        externalKey: resolveUsageObservationExternalKey({
            body: params.normalizedBody,
            fallbackLocalId: params.localId,
        }),
    });
}
