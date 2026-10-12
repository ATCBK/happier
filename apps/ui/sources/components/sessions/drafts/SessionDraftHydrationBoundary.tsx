import * as React from 'react';
import { useActiveServerAccountScopeLifetime, useIsSessionDraftsReady } from '@/sync/domains/state/storage';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { sync } from '@/sync/sync';
import { canonicalSessionDraftAddressV2, type SessionDraftAddressV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** Editable hosts take custody after their own scoped draft hydration attempt. */
export function SessionDraftHydrationBoundary(props: Readonly<{
    children: React.ReactNode;
    /** Omit only when the consumer needs the complete draft collection. */
    addresses?: readonly Extract<SessionDraftAddressV2, { kind: 'session' | 'newSession' }>[];
    lifetime?: ServerAccountScopeLifetime | null;
    /** The host's existing surface shape while first admission is pending. */
    fallback?: React.ReactNode;
}>) {
    const collectionReady = useIsSessionDraftsReady();
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = props.lifetime === undefined ? activeLifetime : props.lifetime;
    const ready = collectionReady && (!lifetime || lifetime.isCurrent())
        && (props.lifetime == null || areServerAccountScopesEqual(lifetime?.scope, activeLifetime?.scope));
    const addressKey = props.addresses?.map(canonicalSessionDraftAddressV2).sort().join('\u0000') ?? null;
    const addresses = React.useRef(props.addresses);
    addresses.current = props.addresses;
    const [admitted, setAdmitted] = React.useState<Readonly<{ lifetime: typeof lifetime; addressKey: typeof addressKey }> | null>(null);
    React.useEffect(() => {
        if (ready || addressKey === null || !lifetime?.isCurrent()) return;
        let mounted = true;
        const requestedAddresses = addresses.current ?? [];
        fireAndForget(Promise.resolve().then(() => sync.prepareSessionDraftSurface(lifetime, requestedAddresses)).then((hydrated) => {
            if (mounted && hydrated && lifetime.isCurrent()) setAdmitted({ lifetime, addressKey });
        }), { tag: 'SessionDraftHydrationBoundary.prepare' });
        return () => { mounted = false; };
    }, [addressKey, lifetime, ready]);
    const admittedLifetime = React.useRef<Readonly<{ lifetime: typeof lifetime; addressKey: typeof addressKey }> | null>(null);
    React.useLayoutEffect(() => {
        if (ready || (admitted?.lifetime === lifetime && admitted?.addressKey === addressKey)) {
            admittedLifetime.current = { lifetime, addressKey };
        }
    }, [addressKey, admitted, lifetime, ready]);
    // This is a first-hydration barrier, not custody revocation. A later pending
    // publication cannot unmount an admitted editor and erase its consumed seed
    // or edits. Only the canonical Account lifetime retires that admission.
    const retainsCustody = lifetime !== null && admittedLifetime.current?.lifetime === lifetime
        && admittedLifetime.current.addressKey === addressKey && lifetime.isCurrent();
    const surfaceReady = admitted !== null && admitted.lifetime === lifetime && admitted.addressKey === addressKey && lifetime?.isCurrent();
    return ready || surfaceReady || retainsCustody
        ? <>{props.children}</>
        : props.fallback ?? <PaneLoadingFallback testID="session-drafts-hydrating" />;
}
