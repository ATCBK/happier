import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : null;
}

/** Read the reduced session-store text and the normalized ingress shape identically. */
export function readVoiceTranscriptMessageText(message: unknown): string | null {
    const record = readRecord(message);
    if (!record) return null;
    if (record.kind === 'user-text' || record.kind === 'agent-text') {
        return typeof record.text === 'string' ? normalizeNonEmptyString(record.text) : null;
    }
    if (record.role === 'user') {
        const content = readRecord(record.content);
        return content?.type === 'text' && typeof content.text === 'string'
            ? normalizeNonEmptyString(content.text)
            : null;
    }
    if (record.role === 'agent' && Array.isArray(record.content)) {
        for (const entry of record.content) {
            const textEntry = readRecord(entry);
            if (!textEntry || textEntry.type !== 'text' || typeof textEntry.text !== 'string') continue;
            return normalizeNonEmptyString(textEntry.text);
        }
    }
    return null;
}
