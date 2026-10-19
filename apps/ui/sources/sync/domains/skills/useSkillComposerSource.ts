import * as React from 'react';
import { loadFoundWarmCacheEntry } from '../state/warmCachePersistence';
import { useServerCredentialAccountScopeBinding } from '../scope/useServerCredentialAccountScopes';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { peekSkillsLibraryItems, readSkillsLibraryItems } from './useSkillsLibrary';
import type { CapabilityApplyTimingV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import type { SkillComposerSelectionOwner, SkillComposerSource, SkillComposerSourceFacts } from './skillComposerGroups';

/**
 * The composer `$` source for one Session or draft (P6 U6.8, mounted by the composer host). Mounting it
 * reads nothing: the `$` kind peeks the last-known library and the Machine's Found warm cache, and reads
 * the library only when the picker asks. The selection owner and apply timing are read at pick time, so the source keeps
 * its identity while the Session controller's callbacks change.
 */
export function useSkillComposerSource(input: Readonly<{
    serverId: string | null;
    agentId: string | null;
    machineId: string | null;
    machineName: string | null;
    owner: SkillComposerSelectionOwner['setItem'];
    /** A running Session's skill apply timing from its controller; omitted for a draft. */
    applyTiming?: CapabilityApplyTimingV1 | null;
}>): SkillComposerSource | null {
    const active = useActiveServerSnapshot(!input.serverId);
    const { binding } = useServerCredentialAccountScopeBinding(input.serverId ?? active.serverId);
    const serverId = binding?.scope.serverId ?? null;
    const accountId = binding?.scope.accountId ?? null;
    const setItem = React.useRef(input.owner);
    setItem.current = input.owner;
    const applyTiming = React.useRef(input.applyTiming ?? null);
    applyTiming.current = input.applyTiming ?? null;
    const { agentId, machineId, machineName } = input;
    return React.useMemo(() => {
        if (!serverId || !accountId || !agentId) return null;
        const scope = { serverId, accountId };
        const found = (): SkillComposerSourceFacts['found'] => {
            const entry = machineId ? loadFoundWarmCacheEntry(serverId, accountId, 'skill', machineId) : null;
            return entry?.kind === 'skill' ? entry : null;
        };
        const peek = (): SkillComposerSourceFacts => ({ libraryItems: peekSkillsLibraryItems(scope) ?? [], found: found() });
        return {
            agentId, machineId, machineName, peek,
            read: async () => ({ libraryItems: (await readSkillsLibraryItems(scope)) ?? [], found: found() }),
            owner: { setItem: (...args) => setItem.current(...args) },
            applyTiming: () => applyTiming.current,
        };
    }, [serverId, accountId, agentId, machineId, machineName]);
}
