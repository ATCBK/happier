import * as React from 'react';

import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { observeHomeSettings } from '@/sync/engine/home/governance/homeSettingsEngine';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';

type RetainSettings = (scope: ServerAccountScope) => void;
const Context = React.createContext<RetainSettings | null>(null);

/** Keeps the first demanded registry alive across pages, without loading it on console entry. */
export function HomeSettingsLifetime(props: Readonly<{ serverId: string; children: React.ReactNode }>) {
    const retained = React.useRef<Readonly<{ scope: ServerAccountScope; release: () => void }> | null>(null);
    const release = React.useCallback(() => {
        retained.current?.release();
        retained.current = null;
    }, []);
    const retain = React.useCallback<RetainSettings>((scope) => {
        if (areServerAccountScopesEqual(retained.current?.scope, scope)) return;
        release();
        retained.current = { scope, release: observeHomeSettings(scope) };
    }, [release]);

    React.useEffect(() => {
        if (retained.current && !areServerProfileIdentifiersEquivalent(retained.current.scope.serverId, props.serverId)) release();
    }, [props.serverId, release]);
    React.useEffect(() => subscribeHomeCredentialChange((event) => {
        if (retained.current && areServerProfileIdentifiersEquivalent(retained.current.scope.serverId, event.serverId)) release();
    }), [release]);
    React.useEffect(() => release, [release]);

    return <Context.Provider value={retain}>{props.children}</Context.Provider>;
}

export function useHomeSettingsLifetime(): RetainSettings | null {
    return React.useContext(Context);
}
