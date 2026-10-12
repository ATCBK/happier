import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { useAcceptedFriends } from '@/sync/store/hooks';

export function resolveHasSessionShareCandidates(input: Readonly<{
    teamCount: number;
    personCount: number;
}>): boolean {
    return input.teamCount > 0 || input.personCount > 0;
}

/**
 * The collapsed New Session access chip needs only this summary fact. Teams
 * and accepted friends retain their own loading, paging, and identity owners;
 * this projection neither copies their rows nor creates another directory.
 */
export function useHasSessionShareCandidates(input: Readonly<{
    serverId: string | null;
    enabled: boolean;
}>): boolean {
    const acceptedFriends = useAcceptedFriends();
    const teams = useTeamsDirectory({
        serverIds: input.serverId ? [input.serverId] : [],
        enabled: input.enabled && input.serverId !== null,
    });
    return input.enabled && resolveHasSessionShareCandidates({
        teamCount: teams.rows.length,
        personCount: acceptedFriends.length,
    });
}
