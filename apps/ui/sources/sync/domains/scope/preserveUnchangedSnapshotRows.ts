/** Compare complete admitted JSON projections rather than a selected subset of fields. */
export function areSnapshotProjectionsEquivalent(previous: unknown, incoming: unknown): boolean {
    return previous === incoming || JSON.stringify(previous) === JSON.stringify(incoming);
}

/** Reuse admitted rows by domain identity, and the array when its ordered contents did not change. */
export function preserveUnchangedSnapshotRows<TRow>(
    previous: readonly TRow[] | null,
    incoming: readonly TRow[],
    keyOf: (row: TRow) => string,
): readonly TRow[] {
    if (!previous) return Object.freeze([...incoming]);
    const previousById = new Map(previous.map(row => [keyOf(row), row]));
    let changed = previous.length !== incoming.length;
    const rows = incoming.map((row, index) => {
        const existing = previousById.get(keyOf(row));
        const next = existing && areSnapshotProjectionsEquivalent(existing, row) ? existing : row;
        if (next !== previous[index]) changed = true;
        return next;
    });
    return changed ? Object.freeze(rows) : previous;
}
