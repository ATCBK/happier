/**
 * Single owner for the opaque per-token component of scoped data-key cache keys.
 *
 * The raw bearer token must not appear in a cache key (it leaks into error and debug
 * output), and hashing it invites cross-token cache reuse on collision. So each distinct
 * token is mapped to a stable process-local random opaque id.
 *
 * Machine transport evidence uses this identity for currentness as well as lookup;
 * seeing unrelated credentials must not give a retained credential a second identity.
 */
const tokenCacheKeyByToken = new Map<string, string>();

function createOpaqueTokenKey(): string {
    const cryptoAny = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    return typeof cryptoAny?.randomUUID === 'function'
        ? cryptoAny.randomUUID()
        : `tk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function getOrCreateScopedCacheTokenKey(token: string): string {
    const existing = tokenCacheKeyByToken.get(token);
    if (existing) {
        return existing;
    }

    const key = createOpaqueTokenKey();
    tokenCacheKeyByToken.set(token, key);

    return key;
}

export function resetScopedCacheTokenKeysForTests(): void {
    tokenCacheKeyByToken.clear();
}
