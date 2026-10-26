import * as React from 'react';

import { useArtifactInventoryRead } from '@/components/artifacts/useArtifactInventoryRead';
import { isArtifactInventoryLoaded } from '@/sync/domains/artifacts/artifactInventory';
import { isInboxArtifactBodyAdmissionComplete } from '@/sync/domains/artifacts/inboxArtifacts';
import { storage, useArtifactsLoaded, useInboxArtifactBodyHydration } from '@/sync/domains/state/storage';

export type InboxArtifactSource = Readonly<{ phase: 'loading' | 'current' | 'partial' | 'failed'; retry: () => void }>;
const SourceContext = React.createContext<InboxArtifactSource | null>(null);

function SourceProvider(props: Readonly<{ children: React.ReactNode }>) {
    const rows = storage(state => state.artifacts);
    const artifacts = React.useMemo(() => Object.values(rows), [rows]);
    const scope = storage(state => state.profileScope);
    const exhausted = useArtifactsLoaded('inboxOpen');
    const loaded = storage(state => state.isDataReady && isArtifactInventoryLoaded(state, 'inboxOpen'));
    const inventory = useArtifactInventoryRead(!exhausted, 'inboxOpen');
    const bodies = useInboxArtifactBodyHydration(artifacts, scope?.serverId, scope?.accountId);
    const phase: InboxArtifactSource['phase'] = inventory.failed || bodies.failed ? 'failed'
        : !exhausted || bodies.pending ? 'loading'
        : loaded && isInboxArtifactBodyAdmissionComplete(artifacts, scope?.accountId) ? 'current' : 'partial';
    const retry = React.useCallback(() => { inventory.retry(); bodies.retry(); }, [inventory.retry, bodies.retry]);
    const value = React.useMemo(() => ({ phase, retry }), [phase, retry]);
    return <SourceContext.Provider value={value}>{props.children}</SourceContext.Provider>;
}

/** The shell summary and its open model share one mounted inventory/body demand. */
export function InboxArtifactSourceBoundary(props: Readonly<{ children: React.ReactNode }>) {
    const existing = React.useContext(SourceContext);
    return existing ? <>{props.children}</> : <SourceProvider>{props.children}</SourceProvider>;
}
export function useInboxArtifactSource(): InboxArtifactSource {
    const source = React.useContext(SourceContext);
    if (!source) throw new Error('Inbox Artifact source boundary is required');
    return source;
}
