import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol/sessions/external/historicalImportIdentity';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { readSessionInputPromptUserTextV1 } from '@happier-dev/protocol/prompts/systemPromptBaseV1';

import { normalizeRawMessages, type NormalizedMessage, type RawMessageNormalizationInput } from "@happier-dev/session-core/raw";

export function normalizeExternalSessionTranscriptMessages(
    items: ReadonlyArray<ExternalSessionTranscriptRawMessageV1>,
    sourceIdentity?: Readonly<{ agentId: string; remoteSessionId: string }>,
): NormalizedMessage[] {
    const displayUserTextById = new Map<string, string>();
    return normalizeRawMessages(items.map((item): RawMessageNormalizationInput => {
        const id = sourceIdentity
            ? makeExternalSessionHistoricalImportLocalId({
                ...sourceIdentity,
                directItemId: item.id,
            })
            : item.id;
        if (typeof item.displayUserText === 'string') displayUserTextById.set(id, item.displayUserText);
        return {
            id,
            localId: typeof item.localId === 'string' ? item.localId : null,
            sidechainId: item.sidechainId ?? undefined,
            createdAt: item.createdAtMs,
            // The projection classifies every row it emits; forwarding that role is what lets
            // normalization drop content-less event rows here exactly as it does for synced sessions.
            messageRole: item.messageRole ?? undefined,
            raw: item.raw,
        };
    })).map(message => {
        if (message.role !== 'user') return message;
        const text = displayUserTextById.get(message.id) ?? readSessionInputPromptUserTextV1(message.content.text);
        // Native records and import/send paths retain the original bytes. Only
        // the shared UI projection (preview, linked transcript and Find) changes.
        return text === message.content.text ? message : { ...message, content: { ...message.content, text } };
    });
}
