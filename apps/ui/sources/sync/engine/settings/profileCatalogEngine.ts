import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { readProfileCatalogProjection } from '@/sync/api/account/apiProfileCatalog';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { applyProfileCatalogSnapshot, beginProfileCatalogLoad, getProfileCatalogSnapshot,
    invalidateProfileCatalog, invalidateProfileCatalogsForServer } from '@/sync/store/settings/profileCatalogSnapshot';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
const targetFor = (scope: ServerAccountScope): Target => ({ key: `profiles:${serverAccountScopeKeySuffix(scope)}`, serverId: scope.serverId, scope });
const loader = createScopedSnapshotLoader<Target>({
    load: async ({ scope }, context) => {
        beginProfileCatalogLoad(scope);
        return context.readWithMaintenance<Awaited<ReturnType<typeof readProfileCatalogProjection>>>({
            read: publication => readProfileCatalogProjection(scope, undefined, publication),
            publish: (result, current, isAccountCurrent) => {
                applyProfileCatalogSnapshot(scope, result.catalog, isAccountCurrent?.() ?? current, result.artifactsById, result, current);
            },
            getPublication: () => getProfileCatalogSnapshot(scope),
        });
    },
    shouldLoadOnObserve: ({ scope }) => {
        const snapshot = getProfileCatalogSnapshot(scope);
        return !snapshot || snapshot.stale;
    },
    invalidateServer: invalidateProfileCatalogsForServer,
    invalidateTarget: ({ scope }) => invalidateProfileCatalog(scope),
    // Focused pages carry the canonical planner decision, including newly granted
    // Artifacts. Secondary content-free wakes retain their existing conservative cut.
    matchesWake: event => event.profileCatalogAffects !== false,
    onCredentialMutation: (_event, { scope }) => {
        applyProfileCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true);
        return true;
    },
});
export function observeProfileCatalog(scope: ServerAccountScope): () => void { return loader.observe(targetFor(scope)); }
export function refreshProfileCatalog(scope: ServerAccountScope): Promise<void> { return loader.refresh(targetFor(scope)); }
export function invalidateProfileCatalogProjection(scope: ServerAccountScope): Promise<void> { return loader.invalidate(targetFor(scope)); }
export function resetProfileCatalogEngineForTests(): void { loader.resetForTests(); }
