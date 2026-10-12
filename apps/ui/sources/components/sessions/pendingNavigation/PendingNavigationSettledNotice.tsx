import * as React from 'react';
import {
    markPendingNavigationSettled,
    usePendingNavigationLanding,
    useSessionPendingAnswerToken,
} from '@/activity/source/pendingNavigationRuntime';
import { useOptionalSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import type { SessionTranscriptSource } from '@/components/sessions/transcript/source/types';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';
import { isSessionActionConfirmationRequest } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';

function PendingNavigationSettlementObserver(props: Readonly<{
    address: SessionAddress;
    requestId: string;
    source: SessionTranscriptSource;
    locatingTranscript: boolean;
}>) {
    const requests = props.source.usePendingRequests();
    const history = props.source.history.useState();
    const connection = props.source.useConnectionState();
    const waiting = requests.permissionRequests.some((request) => request.id === props.requestId)
        || requests.userActionRequests.some((request) => request.id === props.requestId);
    React.useEffect(() => {
        // An unread/offline source is not evidence that another client answered the request.
        if (!history.isLoaded || (connection !== 'live' && connection !== 'static') || waiting
            || (props.locatingTranscript && history.hasOlder)) return;
        markPendingNavigationSettled(props.address, props.requestId);
    }, [connection, history.hasOlder, history.isLoaded, props.address, props.locatingTranscript, props.requestId, waiting]);
    return null;
}

/** The requested card can settle while navigation is in progress; retain that truthful outcome. */
export function PendingNavigationSettledNotice(props: Readonly<{ address: SessionAddress | null }>) {
    const landing = usePendingNavigationLanding(props.address);
    const ownAnswerToken = useSessionPendingAnswerToken(props.address, landing?.requestId);
    const source = useOptionalSessionTranscriptSource();
    if (!landing || (ownAnswerToken !== null && ownAnswerToken > landing.token)) return null;
    if (landing.state === 'pending') {
        if (!source || source.serverId !== landing.address.serverId || source.sessionId !== landing.address.sessionId) return null;
        return <PendingNavigationSettlementObserver address={landing.address} requestId={landing.requestId} source={source}
            locatingTranscript={landing.focusTarget === 'prompt' && !isSessionActionConfirmationRequest({ source: landing.requestSource })} />;
    }
    return <SurfaceStateCard testID="pending-navigation-settled" kind="success" size="line"
        title={t('pendingNavigation.answeredElsewhere')} accessibilitySemantics="status" />;
}
