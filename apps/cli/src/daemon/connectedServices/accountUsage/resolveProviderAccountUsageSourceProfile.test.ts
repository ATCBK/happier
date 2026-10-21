import { describe, expect, it, vi } from 'vitest';

import { resolveProviderAccountUsageSourceProfile } from './resolveProviderAccountUsageSourceProfile';

describe('resolveProviderAccountUsageSourceProfile', () => {
    it('resolves the exact organization among members sharing one provider user', async () => {
        const source = await resolveProviderAccountUsageSourceProfile({
            source: { serviceId: 'claude-subscription', profileId: 'old', bindingKind: 'group_member', groupId: 'group', groupGeneration: 4 },
            providerAccountId: 'same-user', providerOrganizationId: 'org-live',
            getCurrentGroup: async () => ({ generation: 9, members: [{ profileId: 'old' }, { profileId: 'live' }] }),
            resolveProviderAccountIdentity: async (profileId) => ({ providerAccountId: 'same-user',
                providerOrganizationId: profileId === 'live' ? 'org-live' : 'org-old' }),
        });
        expect(source).toMatchObject({ profileId: 'live', groupGeneration: 9 });
    });

    it('attributes a group usage observation to the unique member matching the provider account', async () => {
        const source = await resolveProviderAccountUsageSourceProfile({
            source: {
                serviceId: 'claude-subscription',
                profileId: 'stale-launch-profile',
                bindingKind: 'group_member',
                groupId: 'claude',
                groupGeneration: 4,
            },
            providerAccountId: 'account-live',
            getCurrentGroup: async () => ({
                generation: 9,
                members: [
                    { profileId: 'stale-launch-profile' },
                    { profileId: 'live-profile' },
                ],
            }),
            resolveProviderAccountIdentity: async (profileId) => ({ providerAccountId:
                profileId === 'live-profile' ? 'account-live' : 'account-old' }),
        });

        expect(source).toEqual({
            serviceId: 'claude-subscription',
            profileId: 'live-profile',
            bindingKind: 'group_member',
            groupId: 'claude',
            groupGeneration: 9,
        });
    });

    it('abstains when provider identity is ambiguous', async () => {
        const claimedSource = {
            serviceId: 'claude-subscription' as const,
            profileId: 'launch-profile',
            bindingKind: 'group_member' as const,
            groupId: 'claude',
            groupGeneration: 4,
        };
        const source = await resolveProviderAccountUsageSourceProfile({
            source: claimedSource,
            providerAccountId: 'account-shared',
            getCurrentGroup: async () => ({
                generation: 9,
                members: [{ profileId: 'one' }, { profileId: 'two' }],
            }),
            resolveProviderAccountIdentity: async () => ({ providerAccountId: 'account-shared' }),
        });

        expect(source).toBeNull();
    });

    it('does not read group truth for a direct-profile source', async () => {
        const getCurrentGroup = vi.fn();
        const claimedSource = {
            serviceId: 'claude-subscription' as const,
            profileId: 'direct-profile',
            bindingKind: 'profile' as const,
        };

        await expect(resolveProviderAccountUsageSourceProfile({
            source: claimedSource,
            providerAccountId: 'account-live',
            getCurrentGroup,
            resolveProviderAccountIdentity: vi.fn(),
        })).resolves.toBe(claimedSource);
        expect(getCurrentGroup).not.toHaveBeenCalled();
    });
});
