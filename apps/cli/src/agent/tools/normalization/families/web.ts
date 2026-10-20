import { coerceTextFromContentBlocks } from './toolEnvelope';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

export function normalizeWebFetchInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const url =
        typeof out.url === 'string' && out.url.trim().length > 0
            ? out.url.trim()
            : typeof out.uri === 'string' && out.uri.trim().length > 0
                ? out.uri.trim()
                : typeof out.href === 'string' && out.href.trim().length > 0
                    ? out.href.trim()
                    : typeof out.link === 'string' && out.link.trim().length > 0
                        ? out.link.trim()
                        : null;
    if (url && typeof out.url !== 'string') out.url = url;

    return out;
}

export function normalizeWebFetchResult(rawOutput: unknown): UnknownRecord {
    const record = asRecord(rawOutput);
    if (record) {
        const status = record.status;
        const text =
            typeof record.text === 'string'
                ? record.text
                : typeof record.body === 'string'
                    ? record.body
                    : coerceTextFromContentBlocks(record.content);
        const errorMessage =
            typeof record.errorMessage === 'string'
                ? record.errorMessage
                : typeof record.error === 'string'
                    ? record.error
                    : typeof record.message === 'string'
                        ? record.message
                        : null;

        const out: UnknownRecord = { ...record };
        if (typeof status === 'number') out.status = status;
        if (typeof text === 'string') out.text = text;
        if (typeof errorMessage === 'string' && errorMessage.trim().length > 0) out.errorMessage = errorMessage;
        return out;
    }

    if (Array.isArray(rawOutput)) {
        const text = coerceTextFromContentBlocks(rawOutput);
        if (typeof text === 'string') return { text };
        return { value: rawOutput };
    }

    if (typeof rawOutput === 'string') return { text: rawOutput };
    return { value: rawOutput };
}

export function normalizeWebSearchInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const query =
        typeof out.query === 'string' && out.query.trim().length > 0
            ? out.query.trim()
            : typeof out.q === 'string' && out.q.trim().length > 0
                ? out.q.trim()
                : typeof out.text === 'string' && out.text.trim().length > 0
                    ? out.text.trim()
                    : typeof out.pattern === 'string' && out.pattern.trim().length > 0
                        ? out.pattern.trim()
                        : null;
    if (query && typeof out.query !== 'string') out.query = query;

    return out;
}

export function normalizeWebSearchResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') {
        const text = rawOutput.trim();
        if (text.length > 0) return { results: [{ snippet: text }] };
        return { results: [] };
    }

    if (Array.isArray(rawOutput)) {
        const text = coerceTextFromContentBlocks(rawOutput);
        if (text) return { results: [{ snippet: text }] };
        return { results: rawOutput };
    }

    const record = asRecord(rawOutput);
    if (!record) return { results: [], value: rawOutput };

    const resultsCandidate =
        Array.isArray(record.results)
            ? record.results
            : Array.isArray(record.items)
                ? record.items
                : null;

    if (resultsCandidate) {
        return { results: resultsCandidate };
    }

    const text = coerceTextFromContentBlocks(record.content) ?? (typeof record.text === 'string' ? record.text : null);
    if (typeof text === 'string' && text.trim().length > 0) return { results: [{ snippet: text.trim() }] };
    return { ...record, results: [] };
}
