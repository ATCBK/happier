let activeOperations = 0;
const listeners = new Set<() => void>();

function notifyChanged(): void {
    for (const listener of listeners) {
        // An observer must never interrupt an already admitted SCM operation.
        try { listener(); } catch { /* The caller owns its observer failure. */ }
    }
}

/** Host-local projection of admitted worktree handlers, including native queue waits. */
export const scmWorktreeMutationActivity = Object.freeze({
    isIdle: (): boolean => activeOperations === 0,
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
});

/** Observation only: the backend remains the sole mutation/serialization owner. */
export async function withScmWorktreeMutationActivity<T>(operation: () => Promise<T>): Promise<T> {
    activeOperations += 1;
    if (activeOperations === 1) notifyChanged();
    try { return await operation(); }
    finally {
        activeOperations -= 1;
        if (activeOperations === 0) notifyChanged();
    }
}
