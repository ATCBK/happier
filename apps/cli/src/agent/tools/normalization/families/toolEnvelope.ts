type UnknownRecord = Record<string, unknown>;

export function coerceTextFromContentBlocks(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const record = item as UnknownRecord;
        if (typeof record.text === 'string') parts.push(record.text);
        const nested = record.content;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            const nestedRecord = nested as UnknownRecord;
            if (typeof nestedRecord.text === 'string') parts.push(nestedRecord.text);
        }
    }
    return parts.length > 0 ? parts.join('\n') : null;
}

export function coerceSingleLocationPath(locations: unknown): string | null {
    if (!Array.isArray(locations) || locations.length !== 1) return null;
    const first = locations[0];
    if (!first || typeof first !== 'object') return null;
    const record = first as UnknownRecord;
    return typeof record.path === 'string' && record.path.trim().length > 0
        ? record.path.trim()
        : typeof record.filePath === 'string' && record.filePath.trim().length > 0
            ? record.filePath.trim()
            : null;
}
