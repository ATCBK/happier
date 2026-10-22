import * as React from 'react';
import { useOptionalSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import { readTranscriptNavigationMessagePreview } from './buildTranscriptNavigationLoadedMessages';
import type { TranscriptNavigationEntry } from './transcriptNavigationTypes';

/** Keep live prose in the leaf that displays it, outside list/turn derivation. */
export function useTranscriptNavigationEntryText(entry: TranscriptNavigationEntry | undefined): TranscriptNavigationEntry | undefined {
    const source = useOptionalSessionTranscriptSource();
    const ids = React.useMemo(() => [...new Set([
        ...(entry?.responsePreviewSources ?? []).flatMap(candidate => candidate.messageId ? [candidate.messageId] : []),
        ...(entry?.labelMessageId ? [entry.labelMessageId] : []),
    ])], [entry?.labelMessageId, entry?.responsePreviewSources]);
    const messages = source?.useMessagesByIds(ids);
    return React.useMemo(() => {
        if (!entry || !messages) return entry;
        const byId = new Map(ids.map((id, index) => [id, messages[index]]));
        let responsePreview = entry.responsePreview;
        if (entry.responsePreviewSources) {
            responsePreview = null;
            for (const candidate of entry.responsePreviewSources) {
                const message = candidate.messageId ? byId.get(candidate.messageId) : null;
                const preview = message ? readTranscriptNavigationMessagePreview(message) : candidate.preview;
                if (preview) responsePreview = preview;
            }
        }
        const labelMessage = entry.labelMessageId ? byId.get(entry.labelMessageId) : null;
        const label = labelMessage ? readTranscriptNavigationMessagePreview(labelMessage) ?? entry.label : entry.label;
        return responsePreview === entry.responsePreview && label === entry.label ? entry : { ...entry, responsePreview, label };
    }, [entry, ids, messages]);
}
