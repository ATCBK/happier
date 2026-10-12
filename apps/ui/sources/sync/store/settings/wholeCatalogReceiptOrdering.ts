type CatalogRevision = number | 'absent';

/** Whole-row CAS receipts replace one catalog, including its removed membership. */
export function canPublishCatalogReceipt(input: Readonly<{
    current: boolean;
    revision: number;
    retainedRevision?: CatalogRevision;
}>): boolean {
    return input.current && (typeof input.retainedRevision !== 'number' || input.revision >= input.retainedRevision);
}

/** Partial inventories establish revision evidence without establishing write authority. */
export function retainCatalogRevision(catalog: Readonly<{ status: string; revision?: CatalogRevision }>,
    previous?: CatalogRevision): CatalogRevision {
    return (catalog.status === 'ready' || catalog.status === 'partial') && catalog.revision !== undefined
        ? catalog.revision : previous ?? 'absent';
}
