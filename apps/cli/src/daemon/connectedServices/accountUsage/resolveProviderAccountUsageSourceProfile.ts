import type { ConnectedServiceUsageSourceV1 } from '@happier-dev/protocol';

import { resolveConnectedServiceGroupMemberByProviderAccountId, type ConnectedServiceGroupMemberProviderAccountIdentity } from '../shared/resolveConnectedServiceGroupMemberByProviderAccountId';

type CurrentGroupIdentity = Readonly<{
    generation: number;
    members: readonly Readonly<{ profileId: string }>[];
}>;

export async function resolveProviderAccountUsageSourceProfile(input: Readonly<{
    source: ConnectedServiceUsageSourceV1;
    providerAccountId: string;
    providerOrganizationId?: string | null;
    getCurrentGroup: () => Promise<CurrentGroupIdentity | null>;
    resolveProviderAccountIdentity: (profileId: string) => Promise<ConnectedServiceGroupMemberProviderAccountIdentity | null>;
}>): Promise<ConnectedServiceUsageSourceV1 | null> {
    if (input.source.bindingKind !== 'group_member') return input.source;

    const currentGroup = await input.getCurrentGroup().catch(() => null);
    if (!currentGroup) return null;
    const profileId = await resolveConnectedServiceGroupMemberByProviderAccountId({
        providerAccountId: input.providerAccountId,
        providerOrganizationId: input.providerOrganizationId,
        members: currentGroup.members,
        resolveProviderAccountIdentity: input.resolveProviderAccountIdentity,
    });
    if (!profileId) return null;

    return {
        serviceId: input.source.serviceId,
        profileId,
        bindingKind: 'group_member',
        groupId: input.source.groupId,
        groupGeneration: currentGroup.generation,
    };
}
