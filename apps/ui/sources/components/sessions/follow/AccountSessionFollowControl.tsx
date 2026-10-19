import * as React from 'react';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionListRenderableWithServerScope } from '@/sync/store/hooks';
import { readExternalSessionFollowPolicy } from '@/sync/domains/session/external/externalSessionFollowMetadata';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';

import { AccountSessionFollowEditor } from './AccountSessionFollowEditor';
import { useAccountSessionFollowController } from './useAccountSessionFollowController';
import { useAccountVoiceFollowReadiness } from './useAccountVoiceFollowReadiness';
import { useSessionInProgressTurnId } from './useSessionInProgressTurnId';

export function AccountSessionFollowControl(props: Readonly<{
    address: SessionAddress;
    archived?: boolean;
    onClose?: () => void;
    onOpenNotificationSettings?: () => void;
}>) {
    const enabled = useFeatureEnabled('sessions.following', { scopeKind: 'spawn', serverId: props.address.serverId });
    const { serverId, sessionId } = props.address;
    const { controller, state } = useAccountSessionFollowController(props.address, enabled, props.onClose);
    const voiceReadiness = useAccountVoiceFollowReadiness({
        sessionId,
        serverId,
        initialSnapshotPending: state.voiceInitialSnapshotPending,
    });
    // 09C §11.7: Background sync is the external source's acquisition, never a
    // Follow notification switch. When it is off, Happier can only observe that
    // Session while it is attached, and Follow must say so rather than promise
    // delivery it cannot make. The linked-external fact and the policy come from
    // their existing metadata readers; nothing is decided a second time here.
    // Exact Home: the bare-id entity is whichever Home hydrated that id last, so on a
    // Session that exists on two Homes it could describe the other one's link.
    const metadata = useSessionListRenderableWithServerScope(serverId, sessionId)?.metadata ?? null;
    const sourceTurnId = useSessionInProgressTurnId(props.address);
    const notifyOnce = React.useMemo(() => ({ sourceTurnId, onOnce: controller.setOnce }), [controller, sourceTurnId]);
    const externalBackgroundSyncOff = React.useMemo(() => (
        readExternalSessionLink(metadata) !== null
        && readExternalSessionFollowPolicy(metadata) === 'attached_only'
    ), [metadata]);

    if (!enabled) return null;
    return <AccountSessionFollowEditor
        state={state}
        onEditPolicy={(edit) => { void controller.editPolicy(edit); }}
        voiceReadiness={voiceReadiness}
        archived={props.archived === true}
        externalBackgroundSyncOff={externalBackgroundSyncOff}
        notifyOnce={notifyOnce}
        onSet={(preferences) => { void controller.set(preferences); }}
        onRemove={() => { void controller.remove(); }}
        onRetry={() => { void controller.retry(); }}
        onOpenNotificationSettings={() => { props.onOpenNotificationSettings?.(); }}
    />;
}
