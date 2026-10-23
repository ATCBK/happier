const referenceIds = new WeakMap<object, number>();
let nextReferenceId = 1;

/**
 * React selection identity for an ordered set of immutable owner snapshots.
 * Unrelated publications keep the key; replacing or removing any selected
 * snapshot changes it. Weak keys do not retain superseded snapshots.
 * These ids are local comparison tokens, never revisions or persisted state.
 */
export function snapshotReferenceSelectionKey(snapshots: readonly (object | null | undefined)[]): string {
    return snapshots.map((snapshot) => {
        if (!snapshot) return 0;
        const existing = referenceIds.get(snapshot);
        if (existing !== undefined) return existing;
        const id = nextReferenceId++;
        referenceIds.set(snapshot, id);
        return id;
    }).join(',');
}
