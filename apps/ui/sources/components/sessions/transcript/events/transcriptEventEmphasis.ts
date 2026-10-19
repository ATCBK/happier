import type { Message } from "@happier-dev/session-core/messages";
import { isSessionFollowWakeEventLocalId } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';

export type TranscriptEventEmphasis = 'normal' | 'deemphasized';
export type TranscriptEventEmphasisByMessageId = Readonly<Record<string, TranscriptEventEmphasis>>;

const EMPTY_TRANSCRIPT_EVENT_EMPHASIS_BY_MESSAGE_ID: TranscriptEventEmphasisByMessageId = Object.freeze({});

export function resolveTranscriptEventEmphasisByMessageId(input: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    sessionActive: boolean;
}>): TranscriptEventEmphasisByMessageId {
    if (!input.sessionActive) return EMPTY_TRANSCRIPT_EVENT_EMPHASIS_BY_MESSAGE_ID;

    let latestReadyIndex = -1;
    input.messageIdsOldestFirst.forEach((messageId, index) => {
        const message = input.messagesById[messageId];
        if (message?.kind === 'agent-event' && message.event.type === 'ready') {
            latestReadyIndex = index;
        }
    });
    if (latestReadyIndex < 0) return EMPTY_TRANSCRIPT_EVENT_EMPHASIS_BY_MESSAGE_ID;

    const emphasisByMessageId: Record<string, TranscriptEventEmphasis> = {};
    for (let index = 0; index < latestReadyIndex; index += 1) {
        const messageId = input.messageIdsOldestFirst[index]!;
        const message = input.messagesById[messageId];
        if (message?.kind === 'agent-event' && message.event.type !== 'ready') {
            emphasisByMessageId[messageId] = 'deemphasized';
        }
    }
    return emphasisByMessageId;
}

export type TranscriptHostWakeCountByMessageId = Readonly<Record<string, number>>;

const EMPTY_TRANSCRIPT_HOST_WAKE_COUNT_BY_MESSAGE_ID: TranscriptHostWakeCountByMessageId = Object.freeze({});

/**
 * An adjacent WorkerUpdate run is not provider acceptance. Count only the
 * same-destination cards linked to a batch whose canonical server projection
 * proves a new turn, with the first card displaying that batch's count.
 */
export function resolveTranscriptHostWakeCountByMessageId(input: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): TranscriptHostWakeCountByMessageId {
    const acceptedBatches = new Set<string>();
    for (const messageId of input.messageIdsOldestFirst) {
        const message = input.messagesById[messageId];
        if (message?.kind === 'agent-event'
            && isSessionFollowWakeEventLocalId(message.localId)
            && 'followDeliveryProjection' in message
            && message.followDeliveryProjection?.status === 'woke') {
            acceptedBatches.add(message.localId);
        }
    }
    let counts: Record<string, number> | null = null;
    const openerByBatch = new Map<string, string>();
    for (const messageId of input.messageIdsOldestFirst) {
        const message = input.messagesById[messageId];
        if (message?.kind !== 'agent-event' || message.event.type !== 'worker-update') continue;
        const batchId = message.event.followWakeEventLocalId;
        if (!batchId || !acceptedBatches.has(batchId)) continue;
        counts ??= {};
        const openerId = openerByBatch.get(batchId);
        if (!openerId) {
            openerByBatch.set(batchId, messageId);
            counts[messageId] = 1;
        } else {
            counts[openerId] = (counts[openerId] ?? 0) + 1;
        }
    }
    return counts ?? EMPTY_TRANSCRIPT_HOST_WAKE_COUNT_BY_MESSAGE_ID;
}
