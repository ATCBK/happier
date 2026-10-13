import * as React from 'react';
import type { SkillsLibrary } from './useSkillsLibrary';
import { buildSkillComposerGroups, pickSkillComposerRow, type SkillComposerGroupsInput, type SkillComposerRow, type SkillComposerSelectionOwner } from './skillComposerGroups';
import { loadFoundWarmCacheEntry, subscribeFoundWarmCacheEntry } from '../state/warmCachePersistence';
import { areServerAccountScopesEqual } from '../scope/serverAccountScope';

/** The caller supplies the hydrated library and P2 draft or P8 shared Session controller.
 * Mount inside the demanded picker leaf. This hook makes no Account or Machine reads. */
export function useSkillComposerGroups(input: Omit<SkillComposerGroupsInput, 'found' | 'libraryItems'> & Readonly<{
    library: Pick<SkillsLibrary, 'items' | 'status' | 'stale' | 'scope'>;
    scope: Readonly<{ serverId: string; accountId: string }>;
    capabilities: SkillComposerSelectionOwner;
}>) {
    const { open, query, agentId, sessionItems, machineId, library, capabilities } = input;
    const { serverId, accountId } = input.scope;
    const setItem = capabilities.setItem;
    const currentLibrary = areServerAccountScopesEqual(library.scope, input.scope);
    const demanded = open && currentLibrary;
    const subscribe = React.useCallback((listener: () => void) => demanded && machineId
        ? subscribeFoundWarmCacheEntry(serverId, accountId, 'skill', machineId, listener) : () => {}, [demanded, serverId, accountId, machineId]);
    const getSnapshot = React.useCallback(() => demanded && machineId
        ? loadFoundWarmCacheEntry(serverId, accountId, 'skill', machineId) : null, [demanded, serverId, accountId, machineId]);
    const found = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const groups = React.useMemo(() => buildSkillComposerGroups({ open: demanded, query, agentId, sessionItems, machineId,
        libraryItems: library.items, found: found?.kind === 'skill' ? found : null }), [demanded, query, agentId, sessionItems, machineId, library.items, found]);
    const pick = React.useCallback((row: SkillComposerRow) => {
        if (!open || !groups.some(group => group.rows.includes(row))) return Promise.resolve({ ok: false as const, message: 'stale_skill_pick' });
        return pickSkillComposerRow(row, { setItem });
    }, [open, groups, setItem]);
    return { groups, pick, status: currentLibrary ? library.status : 'unavailable' as const, stale: library.stale };
}
