import * as React from 'react';

import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { CLOSED_SESSION_VIEWER, type SessionViewerPresentationState } from './sessionViewerPresentation';

function createPresentationState(isCurrent: () => boolean = () => true) {
    let state = CLOSED_SESSION_VIEWER;
    const listeners = new Set<() => void>();
    return {
        getSnapshot: () => isCurrent() ? state : CLOSED_SESSION_VIEWER,
        setState(next: SessionViewerPresentationState) {
            if (!isCurrent() || next === state) return;
            state = next;
            for (const listener of listeners) listener();
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

type DestinationViewerScope = Readonly<{
    sessionId: string;
    accountLifetime: ServerAccountScopeLifetime;
    presentation: ReturnType<typeof createPresentationState>;
}>;

const DestinationViewerContext = React.createContext<DestinationViewerScope | null>(null);

/**
 * Presentation and viewing authority outlive the classic/cockpit shell replacement. The destination
 * owns their lifetime; the shell still owns pane callbacks, and the retained source owns its stream.
 */
export function SessionViewerDestinationScope(props: React.PropsWithChildren<Readonly<{
    sessionId: string;
    serverId: string | null;
}>>): React.ReactElement {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    const scope = React.useMemo<DestinationViewerScope | null>(() => binding ? {
        sessionId: props.sessionId,
        accountLifetime: binding,
        presentation: createPresentationState(binding.isCurrent),
    } : null, [binding, props.sessionId]);
    return <DestinationViewerContext.Provider value={scope}>{props.children}</DestinationViewerContext.Provider>;
}

export function useSessionViewerDestinationScope(sessionId: string, serverId: string | null): DestinationViewerScope | null {
    const scope = React.useContext(DestinationViewerContext);
    return scope?.sessionId === sessionId && scope.accountLifetime.isCurrent() && serverId !== null
        && areServerProfileIdentifiersEquivalent(scope.accountLifetime.scope.serverId, serverId) ? scope : null;
}

/** A standalone/embedded Session keeps its existing local owner; a destination supplies the same one across shells. */
export function useSessionViewerPresentationState(sessionId: string, serverId: string | null) {
    const destination = useSessionViewerDestinationScope(sessionId, serverId);
    const local = React.useMemo(() => createPresentationState(), [serverId, sessionId]);
    const owner = destination?.presentation ?? local;
    const state = React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
    return { state, setState: owner.setState, readState: owner.getSnapshot };
}

/**
 * Whether the Session's viewer is presented now, read on demand by a caller that must not follow
 * presentation changes (a cockpit deciding where to land as it mounts). Standalone and embedded
 * Sessions have no destination owner and read as not presenting.
 */
export function useSessionViewerPresentingReader(sessionId: string, serverId: string | null): () => boolean {
    const destination = useSessionViewerDestinationScope(sessionId, serverId);
    return React.useCallback(
        () => destination !== null && destination.presentation.getSnapshot().mode !== 'closed',
        [destination],
    );
}
