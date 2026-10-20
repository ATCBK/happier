import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';
import type { PersonalFollowOnceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { useAccountSessionFollowController } from '@/components/sessions/follow/useAccountSessionFollowController';
import { useSessionInProgressTurnId } from '@/components/sessions/follow/useSessionInProgressTurnId';
import type { AccountSessionFollowEditorSnapshot } from '@/components/sessions/follow/accountSessionFollowController';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { getStorage } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { WorkNotificationGroup, WorkNotificationOperationView } from './WorkNotificationOperation';

const stylesheet = StyleSheet.create(() => ({
    // On the Work sheet's own row inset, like the Role and Goal rows above it: an extra inset narrowed
    // the row until its switch dropped beneath the label.
    operations: { minWidth: 0, paddingBottom: 6 },
}));

/** This operation never silently routes a foreign Home through the active Account. */
export function SessionWorkNotifications(props: Readonly<{ sessionId: string; serverId?: string | null }>) {
    const scope = useActiveServerAccountScope();
    if (!scope || (props.serverId && !areServerProfileIdentifiersEquivalent(props.serverId, scope.serverId))) return null;
    return <SessionWorkNotificationsForAccount key={`${scope.serverId}:${scope.accountId}:${props.sessionId}`}
        sessionId={props.sessionId} serverId={scope.serverId} />;
}

function SessionWorkNotificationsForAccount(props: Readonly<{ sessionId: string; serverId: string }>) {
    const enabled = useFeatureEnabled('sessions.following', { scopeKind: 'spawn', serverId: props.serverId });
    const { controller, state } = useAccountSessionFollowController(props, enabled);
    // Exact-turn binding reads the turn identity itself, not the shell's intentionally
    // coarser presentation signature (two in-progress turns have the same status).
    const turnId = useSessionInProgressTurnId(props);
    const source = getStorage()(useShallow((state) => {
        const session = state.sessions[props.sessionId];
        return { available: Boolean(session), archived: session?.archivedAt != null };
    }));
    if (!enabled || !source.available || source.archived) return null;
    return <SessionWorkNotifyOperation sessionId={props.sessionId} sourceTurnId={turnId} state={state} onOnce={controller.setOnce} />;
}

/** Personal convenience changes only Account Follow and never an authored Habit. */
export function SessionWorkNotifyOperation(props: Readonly<{
    sessionId: string;
    sourceTurnId: string | null;
    state: AccountSessionFollowEditorSnapshot;
    onOnce: (once: PersonalFollowOnceV1 | null) => Promise<void>;
}>) {
    const once = props.state.projection?.follow?.once;
    const disabled = !props.state.online || props.state.saving || props.state.projection?.capabilities.manageFollow !== true;
    const choice = (mode: 'turn' | 'attention') => {
        const armed = mode === 'turn' ? once?.kind === 'turn_finished' && once.sourceTurnId === props.sourceTurnId
            : once?.kind === 'first_needs_you';
        if (props.state.error && !props.state.projection && !armed) return null;
        return <WorkNotificationOperationView key={mode === 'turn' ? props.sourceTurnId : mode}
            sourceId={props.sessionId} testIDPrefix={`notify-${mode}`}
            title={mode === 'turn' ? t('sessionWork.notify.turn') : t('sessionWork.notify.attention')}
            armed={armed} pending={props.state.saving} disabled={disabled} error={props.state.error !== null}
            onChange={async enabled => { await props.onOnce(enabled
                ? mode === 'turn' ? { kind: 'turn_finished', sourceTurnId: props.sourceTurnId! } : { kind: 'first_needs_you' }
                : null); }} />;
    };
    return <WorkNotificationGroup sourceId={props.sessionId} style={stylesheet.operations}>
        {props.sourceTurnId === null ? null : choice('turn')}
        {choice('attention')}
    </WorkNotificationGroup>;
}
