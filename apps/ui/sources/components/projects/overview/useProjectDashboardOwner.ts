import * as React from 'react';

import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScopeLifetime, useFriend, useUser } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type ProjectDashboardOwnerDisplay = Readonly<{
    accountId: string;
    displayName: string;
    imageUrl: string | null;
}>;

/** Safe owner facts use the Home's existing people projection, independently of Artifact authority. */
export function useProjectDashboardOwner(serverId: string, ownerAccountId: string | null): ProjectDashboardOwnerDisplay | null {
    const lifetime = useActiveServerAccountScopeLifetime();
    const viewer = selectActiveServerAccountScopeForServer(lifetime?.scope ?? null, serverId);
    const ownerId = viewer && lifetime?.isCurrent() ? ownerAccountId ?? undefined : undefined;
    const user = useUser(ownerId);
    const friend = useFriend(ownerId);
    const viewerProfile = useShareViewerProfile(viewer && ownerId === viewer.accountId ? viewer : { serverId, accountId: '' });
    React.useEffect(() => {
        if (!ownerId || !lifetime || ownerId === viewer?.accountId || user !== undefined || friend) return;
        let mounted = true;
        fireAndForget(sync.assumeUsers([ownerId], { shouldContinue: () => mounted && lifetime.isCurrent() }),
            { tag: 'useProjectDashboardOwner' });
        return () => { mounted = false; };
    }, [friend, lifetime, ownerId, user, viewer?.accountId]);
    const person = user ?? friend;
    return React.useMemo(() => {
        if (!ownerId || !viewer) return null;
        const presentation = presentSharePrincipal({
            ref: { kind: 'account', accountId: ownerId },
            profile: person ? { name: person.name, firstName: person.firstName, lastName: person.lastName,
                username: person.username, avatarUrl: person.avatar?.url ?? null } : null,
            viewerProfile,
            viewerAccountId: viewer.accountId,
        });
        return { accountId: ownerId, displayName: presentation.displayName, imageUrl: presentation.avatar?.imageUrl ?? null };
    }, [ownerId, person, viewer, viewerProfile]);
}
