import { describe, expect, it } from 'vitest';

import { getAvatarUrl, getLinkedProvider, profileDefaults, tryParseProfile } from './profile';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';

describe('profile helpers', () => {
    it('restores stored profiles while dropping retired nested fields', () => {
        const profile = { ...profileDefaults, id: 'account-a', connectedServicesV2: [{ serviceId: 'anthropic',
            profiles: [{ profileId: 'work', status: 'connected', retired: true }], retired: true }], retired: true };
        const parsed = tryParseProfile(profile);
        expect(parsed).not.toBeNull();
        expect(parsed).not.toHaveProperty('retired');
        expect(parsed?.connectedServicesV2[0]?.profiles[0]).not.toHaveProperty('retired');
    });
    it('treats missing linkedProviders as an empty list when deriving display details', () => {
        const profile = {
            ...profileDefaults,
            name: 'Lee',
            firstName: 'Lee',
            linkedProviders: undefined,
            avatar: null,
        } as any;

        expect(formatAccountDisplayName(profile)).toBe('Lee');
        expect(getAvatarUrl(profile)).toBeNull();
        expect(getLinkedProvider(profile, 'anthropic')).toBeNull();
    });

    it('uses the canonical name or username without replacing a cleared name with a linked identity', () => {
        const profile = { ...profileDefaults, name: 'Chosen Name', firstName: 'Legacy', username: 'lee',
            linkedProviders: [{ id: 'github', displayName: 'Provider Name', login: 'provider-login', avatarUrl: null,
                profileUrl: null, showOnProfile: true }] };
        expect(formatAccountDisplayName(profile)).toBe('Chosen Name');
        expect(formatAccountDisplayName({ ...profile, name: null })).toBe('lee');
        expect(formatAccountDisplayName({ ...profile, name: null, username: null })).toBeNull();
    });
});
