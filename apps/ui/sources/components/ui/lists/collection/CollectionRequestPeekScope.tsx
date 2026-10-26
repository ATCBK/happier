import * as React from 'react';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { collectionRequestRefKey, type CollectionRequestRef } from './collectionRequestRef';

export type CollectionRequestPeekScopeState = Readonly<{ kind: 'loading' | 'unavailable' }>
    | Readonly<{ kind: 'current'; binding: ServerCredentialAccountScopeBinding }>;

/** Only the opened leaf resolves credentials; retirement withdraws every request family's private body. */
export function CollectionRequestPeekScope(props: Readonly<{
    request: CollectionRequestRef;
    open: boolean;
    onRetire?: () => void;
    children(state: CollectionRequestPeekScopeState): React.ReactNode;
}>): React.ReactNode {
    return props.open ? <OpenedScope key={collectionRequestRefKey(props.request)} {...props} /> : null;
}

function OpenedScope(props: React.ComponentProps<typeof CollectionRequestPeekScope>): React.ReactNode {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(props.request.serverId);
    const captured = React.useRef<ServerCredentialAccountScopeBinding | null>(null);
    if (captured.current === null && binding?.isCurrent()) captured.current = binding;
    const lifetime = captured.current;
    const [retired, setRetired] = React.useState(false);
    const onRetire = React.useRef(props.onRetire);
    onRetire.current = props.onRetire;
    React.useLayoutEffect(() => {
        if (!lifetime) return;
        const subscription = lifetime.onRetire(() => { setRetired(true); onRetire.current?.(); });
        return () => subscription.dispose();
    }, [lifetime]);
    // A new Account or renewed credential must review again instead of inheriting this disclosure.
    const current = !retired && lifetime !== null && lifetime === binding && lifetime.isCurrent();
    return props.children(current ? { kind: 'current', binding: lifetime }
        : { kind: lifetime === null && resolution.kind === 'resolving' ? 'loading' : 'unavailable' });
}
