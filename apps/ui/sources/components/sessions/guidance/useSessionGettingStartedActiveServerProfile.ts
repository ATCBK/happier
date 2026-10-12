import * as React from 'react';

import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';

import { resolveActiveServerProfile } from './gettingStartedModel';

export function useSessionGettingStartedActiveServerProfile(activeServerId: string) {
    const serverProfilesGeneration = useServerProfilesGeneration();
    const serverProfiles = React.useMemo(() => {
        return listServerProfiles();
    }, [serverProfilesGeneration]);

    return React.useMemo(() => {
        return resolveActiveServerProfile(serverProfiles, activeServerId);
    }, [activeServerId, serverProfiles]);
}
