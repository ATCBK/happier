import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';

/**
 * The synced name of exactly this Home's Account (`''` when it has none), or `null` while that
 * Account's profile is not the one in sync. Without a scope it reads the Account in sync now.
 * `label` is how the app names that Account on screen (its name, else its username), or `null`.
 */
export function useSyncedAccountName(
    scope?: ServerAccountScope | null,
): Readonly<{ name: string; label: string | null }> | null {
    const store = getStorage();
    // Primitive selectors: a profile change that touches neither field never rerenders the caller.
    const field = (state: ReturnType<typeof store.getState>, key: 'name' | 'username') => {
        const target = scope === undefined ? state.profileScope : scope;
        return target
            && target.accountId
            && areServerAccountScopesEqual(state.profileScope, target)
            && state.profile.id === target.accountId
            ? (state.profile[key] ?? '')
            : undefined;
    };
    const name = store((state) => field(state, 'name'));
    const username = store((state) => field(state, 'username'));
    return name === undefined
        ? null
        : { name, label: formatAccountDisplayName({ name, username }) };
}
