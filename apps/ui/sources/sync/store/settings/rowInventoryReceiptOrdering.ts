import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Display receipt ordering only; retained revisions never establish read or mutation authority. */
export function createRowInventoryReceiptOrdering() {
    const revisionsByScope = new Map<string, Map<string, number>>();

    function retain(scope: ServerAccountScope, id: string, revision: number | null | undefined): void {
        if (typeof revision !== 'number') return;
        const key = serverAccountScopeKeySuffix(scope);
        const revisions = revisionsByScope.get(key) ?? new Map<string, number>();
        revisions.set(id, Math.max(revision, revisions.get(id) ?? revision));
        revisionsByScope.set(key, revisions);
    }

    return {
        retain,
        admit(scope: ServerAccountScope, id: string, revision: number | null): boolean {
            if (typeof revision !== 'number') return false;
            const retained = revisionsByScope.get(serverAccountScopeKeySuffix(scope))?.get(id);
            if (retained !== undefined && retained >= revision) return false;
            retain(scope, id, revision);
            return true;
        },
        /** A physical delete acknowledges its admitted input revision, without inventing a successor. */
        admitRemoval(scope: ServerAccountScope, id: string, revision: number | null | undefined): boolean {
            const retained = revisionsByScope.get(serverAccountScopeKeySuffix(scope))?.get(id);
            if (typeof revision === 'number' && retained !== undefined && retained > revision) return false;
            retain(scope, id, revision);
            return true;
        },
        clearScope(scope: ServerAccountScope): void { revisionsByScope.delete(serverAccountScopeKeySuffix(scope)); },
        reset(): void { revisionsByScope.clear(); },
    };
}
