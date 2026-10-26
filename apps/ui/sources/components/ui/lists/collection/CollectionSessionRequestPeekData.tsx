import * as React from 'react';
import type { Metadata } from '@happier-dev/session-core/state';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { useHydrateSession } from '@/hooks/session/useHydrateSessionForRoute';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { selectHomeQualifiedSession } from '@/sync/domains/session/selectHomeQualifiedSession';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { resolveCollectionSessionRequest,
    type CollectionSessionRequestRef, type CollectionSessionRequestResolution } from './collectionRequestRef';
import { CollectionRequestPeekScope } from './CollectionRequestPeekScope';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { collectionRequestRefKey } from './collectionRequestRef';
import { t } from '@/text';

export type CollectionSessionRequestPeekState = Readonly<{ retry?: () => Promise<boolean> }> & (
    | Readonly<{ kind: 'loading' | 'unavailable' }>
    | Exclude<CollectionSessionRequestResolution, { kind: 'current' }>
    | Readonly<{ kind: 'current'; request: Extract<CollectionSessionRequestResolution, { kind: 'current' }>['request'];
        session: Session; metadata: Metadata | null; interaction: TranscriptInteraction }>);

type Props = Readonly<{
    request: CollectionSessionRequestRef;
    open: boolean;
    onRetire?: () => void;
    children(state: CollectionSessionRequestPeekState): React.ReactNode;
}>;

/** Closed rows mount no request hooks, transcript demand, credentials or private body projection. */
export function CollectionSessionRequestPeekData(props: Props): React.ReactNode {
    return <CollectionRequestPeekScope request={props.request} open={props.open} onRetire={props.onRetire}>
        {state => state.kind === 'current' ? <OpenedSessionRequest {...props} /> : props.children(state)}
    </CollectionRequestPeekScope>;
}

function OpenedSessionRequest(props: Props): React.ReactNode {
    const hydration = useHydrateSession(props.request.sessionId, 'collection.requestPeek', {
        serverId: props.request.serverId, hydrateMessages: true,
    });
    const retryKey = `request.retry:${collectionRequestRefKey(props.request)}`;
    const commands = useCurrentUiContextLocalCommands(React.useMemo(() => [{
        key: retryKey, title: t('common.retry'), invoke: hydration.retry,
    }], [hydration.retry, retryKey]));
    const retry = React.useCallback(() => commands.invoke(retryKey), [commands, retryKey]);
    return <AppSessionTranscriptSourceProvider sessionId={props.request.sessionId} serverId={props.request.serverId}>
        <CurrentSessionRequest {...props} loading={hydration.kind === 'loading'} retry={retry} />
    </AppSessionTranscriptSourceProvider>;
}

function CurrentSessionRequest(props: Props & Readonly<{ loading: boolean; retry: () => Promise<boolean> }>): React.ReactNode {
    const source = useSessionTranscriptSource();
    const pending = source.usePendingRequests();
    const metadata = source.useMetadata();
    const interaction = source.useInteraction();
    const activeServerId = useActiveServerSnapshot().serverId;
    const session = storage(React.useCallback((state: StorageState) => selectHomeQualifiedSession(state,
        props.request.sessionId, props.request.serverId, activeServerId), [activeServerId, props.request.serverId, props.request.sessionId]));
    if (!session) return props.children({ kind: props.loading ? 'loading' : 'unavailable', retry: props.retry });
    if (session.access?.capabilities.readTranscript !== true
        || !isSessionContentReadable(readSessionContentAvailability(session))) return props.children({ kind: 'unavailable', retry: props.retry });
    const resolution = resolveCollectionSessionRequest(props.request, {
        serverId: source.serverId ?? '', sessionId: source.sessionId,
    }, pending);
    if (resolution.kind === 'settled' && props.loading) return props.children({ kind: 'loading', retry: props.retry });
    return props.children(resolution.kind === 'current'
        ? { ...resolution, session, metadata, interaction, retry: props.retry } : { ...resolution, retry: props.retry });
}
