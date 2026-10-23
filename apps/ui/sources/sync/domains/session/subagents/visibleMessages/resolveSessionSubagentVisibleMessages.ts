import { compareTranscriptMessagesOldestFirst, type Message, type ToolCall } from "@happier-dev/session-core/messages";
import { readParticipantRecipientRoutingIdentityV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
    BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_DESCRIPTORS,
    BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY,
} from '@/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers';
import { isBundledAgentId, resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

import { deriveSessionSubagents } from '../deriveSessionSubagents';
import { findMatchingSessionSubagentForTool } from '../findMatchingSessionSubagentForTool';
import type { SessionSubagentActiveExecutionRunState } from '../types';
import { createVisibleMessagesResolverFromDescriptor } from './visibleMessageDescriptors';
import { resolveProjectedAgentUiBehaviorEntry } from '@/agents/registry/agentUiBehaviorProjection';
import { readExecutionRunIdFromToolPayload } from '../../participants/deriveExecutionRunPollingRefreshKey';

/** Run replies live in a sidechain; committed participant questions live in the parent transcript. */
export function resolveExecutionRunVisibleMessages(params: Readonly<{
    runId: string;
    messages: readonly Message[];
    focusedMessages: readonly Message[];
}>): readonly Message[] {
    const { focusedMessages } = params;
    const ids = new Set(focusedMessages.flatMap(message => [message.id, message.realID].filter(Boolean)));
    const localIds = new Set(focusedMessages.map(message => message.localId).filter(Boolean));
    const questions = params.messages.filter(message => {
        if (message.kind !== 'user-text' || ids.has(message.id) || (message.realID && ids.has(message.realID))
            || (message.localId && localIds.has(message.localId))) return false;
        const recipient = readParticipantRecipientRoutingIdentityV1(message.meta, 'stored');
        return recipient?.kind === 'execution_run' && recipient.runId === params.runId;
    });
    return questions.length === 0 ? focusedMessages : [...focusedMessages, ...questions].sort(compareTranscriptMessagesOldestFirst);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createVisibleMessageSessionDescriptor(descriptor: Readonly<Record<string, unknown>>): Record<string, unknown> {
    if (descriptor.kind === 'session.visibleMessages.v1') {
        return { visibleMessages: descriptor };
    }
    return {};
}

function declaresProjectedVisibleMessages(descriptor: Readonly<Record<string, unknown>>): boolean {
    const session = isRecord(descriptor.session) ? descriptor.session : null;
    return session !== null
        && Object.hasOwn(session, 'visibleMessages');
}

export function resolveSessionSubagentVisibleMessages(params: Readonly<{
    accountScope?: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope | null;
    session: Session;
    tool: ToolCall;
    messages: readonly Message[];
    focusedMessages?: readonly Message[];
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
}>): readonly Message[] {
    const runId = params.tool.name === 'SubAgentRun' ? readExecutionRunIdFromToolPayload(params.tool) : null;
    if (runId) return resolveExecutionRunVisibleMessages({ ...params, runId, focusedMessages: params.focusedMessages ?? [] });
    if (!Array.isArray(params.focusedMessages) || params.focusedMessages.length === 0) return [];

    const subagents = deriveSessionSubagents({
        accountScope: params.accountScope,
        session: params.session,
        messages: params.messages,
        activeExecutionRuns: params.activeExecutionRuns,
    });
    const subagent = findMatchingSessionSubagentForTool({
        tool: params.tool,
        subagents,
    });

    const ownerMetadata = readSessionOwnerMetadataView(params.session);
    const rawFlavor = ownerMetadata?.flavor;
    const agentId = resolveAgentIdFromSessionMetadata(ownerMetadata)
        ?? resolveAgentIdFromFlavor(typeof rawFlavor === 'string' ? rawFlavor : null);
    if (!agentId) return params.focusedMessages;

    const machineId = typeof ownerMetadata?.machineId === 'string' && ownerMetadata.machineId.trim().length > 0
        ? ownerMetadata.machineId.trim()
        : null;
    const projected = machineId
        ? resolveProjectedAgentUiBehaviorEntry(agentId, machineId, params.accountScope)
        : null;
    const projectedDeclaration = projected && declaresProjectedVisibleMessages(projected.descriptor)
        ? [{
            agentId,
            resolveVisibleMessages: createVisibleMessagesResolverFromDescriptor(projected.descriptor).resolveVisibleMessages,
        }]
        : null;
    if (!projectedDeclaration && !isBundledAgentId(agentId)) {
        return params.focusedMessages;
    }

    const descriptorEntries = projectedDeclaration ?? BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_DESCRIPTORS
        .filter((entry) => entry.agentId === agentId)
        .map((entry) => ({
            agentId: entry.agentId,
            resolveVisibleMessages: createVisibleMessagesResolverFromDescriptor({
                kind: 'plugin.ui.v1',
                pluginId: entry.agentId,
                agentId: entry.agentId,
                version: 1,
                session: isRecord(entry.descriptor) ? createVisibleMessageSessionDescriptor(entry.descriptor) : {},
            }).resolveVisibleMessages,
        }));

    const registryEntries = projectedDeclaration
        ? []
        : BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY.filter((entry) => entry.agentId === agentId);
    for (const entry of [...descriptorEntries, ...registryEntries]) {
        let visibleMessages: readonly Message[] | null = null;
        try {
            visibleMessages = entry.resolveVisibleMessages({
                ...params,
                focusedMessages: params.focusedMessages,
                subagents,
                subagent,
            });
        } catch {
            visibleMessages = null;
        }
        if (visibleMessages) return visibleMessages;
    }

    return params.focusedMessages;
}
