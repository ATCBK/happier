function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the provider callback view of a generic ACP tool observation. Standard ACP title
 * metadata is additive inference context under `_acp`; the accumulated raw input remains the
 * transcript payload and is never mutated by this helper. Keeping observation metadata out of
 * top-level input fields prevents generic title-bearing observations from impersonating a real
 * `{ title: ... }` tool input.
 */
export function buildAcpToolNameResolverInput(input: unknown, title: unknown): Readonly<Record<string, unknown>> {
    const base = isRecord(input) ? input : Object.freeze({});
    if (typeof title !== 'string') {
        return base;
    }
    const normalizedTitle = title.trim();
    if (normalizedTitle.length === 0) return base;

    const next: Record<string, unknown> = { ...base };
    const existingAcp: Readonly<Record<string, unknown>> = isRecord(next._acp)
        ? next._acp
        : Object.freeze({});
    // The observed tool-call title belongs to the transport, while a similarly named
    // field inside rawInput is an operand and cannot replace permission identity.
    next._acp = Object.freeze({ ...existingAcp, title: normalizedTitle });
    return Object.freeze(next);
}
