/** The last mounted source remains available while the person writes in the composer. */
const sourcesByScope = new Map<string, string>();
const listeners = new Set<() => void>();

export const askSelectionContext = {
    read: (scopeId: string) => sourcesByScope.get(scopeId) ?? null,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    remember(scopeId: string, sourceId: string) {
        if (sourcesByScope.get(scopeId) === sourceId) return;
        sourcesByScope.set(scopeId, sourceId);
        for (const listener of listeners) listener();
    },
    forget(scopeId: string, sourceId: string) {
        if (sourcesByScope.get(scopeId) !== sourceId) return;
        sourcesByScope.delete(scopeId);
        for (const listener of listeners) listener();
    },
};
