import * as React from 'react';

import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

/**
 * Retire Provider screen-local authoring state when the active Account
 * lifetime retires or its already-resolved addressed Account changes.
 *
 * Provider routes are not Account-keyed and the app subtree stays mounted
 * across a normal Account change, so a draft, editor buffer, or queued
 * operation authored under Account A survives the switch. Nothing in the
 * request identity can refuse it afterwards: Account B can restore the same
 * server identity, machine, connection id and revision, while the Connected
 * Account references inside the draft still belong to A.
 *
 * Addressed identity comes from the caller's existing Action client; this
 * hook does not resolve credentials or replace that client's peer currentness.
 * Its returned lifetime still represents active-Account UI interest. `retire`
 * must be stable across renders — the effect re-registers whenever it changes.
 */
export function useRetireProviderStateOnAccountChange(
    retire: () => void,
    addressedScope?: ServerAccountScope | null,
): ActiveServerAccountScopeLifetime | null {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(retire);
        return () => registration?.dispose();
    }, [accountLifetime, retire]);
    const previousAddressedScope = React.useRef(addressedScope);
    React.useEffect(() => {
        const previous = previousAddressedScope.current;
        previousAddressedScope.current = addressedScope;
        // A profile metadata recheck retains the same resolved Account even
        // while its credential binding renews. Only withdrawal or replacement
        // retires drafts; first admission must preserve the route's seed state.
        if (previous && !areServerAccountScopesEqual(previous, addressedScope)) retire();
    }, [addressedScope, retire]);
    return accountLifetime;
}
