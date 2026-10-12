import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol';

import { buildTriggerDefinition, buildTriggerTarget, readTriggerThen } from '@/components/workflows/triggers/sessionTriggerForm';
import { useSessionTriggers, type SessionTriggersRead } from '@/components/workflows/triggers/useSessionTriggers';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { getStorage } from '@/sync/domains/state/storage';
import type { WorkflowActionExecute } from '@/sync/domains/workflows/callWorkflowAction';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { WorkNotificationOperation } from './WorkNotificationOperation';

const stylesheet = StyleSheet.create(() => ({
    // On the Work sheet's own row inset, like the Role and Goal rows above it: an extra inset narrowed
    // the row until its switch dropped beneath the label.
    operations: { minWidth: 0, paddingBottom: 6 },
}));

/** This operation never silently routes a foreign Home through the active Account. */
export function SessionWorkNotifications(props: Readonly<{ sessionId: string; serverId?: string | null }>) {
    const scope = useActiveServerAccountScope();
    if (!scope || (props.serverId && !areServerProfileIdentifiersEquivalent(props.serverId, scope.serverId))) return null;
    return <SessionWorkNotificationsForAccount key={`${scope.serverId}:${scope.accountId}:${props.sessionId}`} {...props} />;
}

function SessionWorkNotificationsForAccount(props: Readonly<{ sessionId: string; serverId?: string | null }>) {
    // Exact-turn binding reads the turn identity itself, not the shell's intentionally
    // coarser presentation signature (two in-progress turns have the same status).
    const source = getStorage()(useShallow((state) => {
        const session = state.sessions[props.sessionId];
        return { available: Boolean(session), archived: session?.archivedAt != null,
            turnId: session?.latestTurnStatus === 'in_progress' ? session.latestTurnId ?? null : null };
    }));
    const read = useSessionTriggers(props.sessionId);
    if (!source.available || source.archived) return null;
    return <SessionWorkNotifyOperation sessionId={props.sessionId} sourceTurnId={source.turnId} read={read} />;
}

/** The public trigger command and its projection are the only state behind the quiet operation. */
export function SessionWorkNotifyOperation(props: Readonly<{ sessionId: string; sourceTurnId: string | null; read: SessionTriggersRead; execute?: WorkflowActionExecute }>) {
    return <View style={stylesheet.operations}>
        {props.sourceTurnId === null ? null : <NotificationChoice key={props.sourceTurnId} {...props} mode="turn" />}
        <NotificationChoice {...props} mode="attention" />
    </View>;
}

function NotificationChoice(props: Readonly<{ sessionId: string; sourceTurnId: string | null; read: SessionTriggersRead; mode: 'turn' | 'attention'; execute?: WorkflowActionExecute }>) {
    const message = props.mode === 'turn' ? t('sessionWork.notify.turnFinished') : t('sessionWork.notify.needsYou');
    const match = (set: WorkflowTriggerSetV1) => {
        const then = set.target ? readTriggerThen(set.target) : null;
        if (!set.enabled || set.health !== 'available' || then?.kind !== 'notifyMe' || then.message !== message) return null;
        return set.triggers.find((trigger) => trigger.kind === 'sessionLifecycle' && trigger.enabled
            && trigger.status.state === 'waiting' && trigger.remainingOccurrences !== 0
            && trigger.sourceSessionId === props.sessionId
            && (props.mode === 'turn'
                ? trigger.policy.kind === 'currentTurn' && trigger.policy.sourceTurnId === props.sourceTurnId
                : trigger.policy.kind === 'firstMatch' && trigger.events.length === 1 && trigger.events[0] === 'userActionRequired'))?.id ?? null;
    };
    const add = async () => {
        const trigger = buildTriggerDefinition({ sessionId: props.sessionId, enabled: true,
            when: props.mode === 'turn' ? { kind: 'turnEnds', sourceTurnId: props.sourceTurnId! } : { kind: 'needsYou' } });
        const target = buildTriggerTarget({ kind: 'notifyMe', message, title: '', channels: [] });
        if (!trigger || !target || trigger.kind !== 'sessionLifecycle') throw new Error('Invalid notification trigger');
        return props.read.add({ target,
            trigger: props.mode === 'attention' ? { ...trigger, policy: { kind: 'firstMatch' } } : trigger });
    };
    return <WorkNotificationOperation sourceId={props.sessionId} testIDPrefix={`notify-${props.mode}`}
        title={props.mode === 'turn' ? t('sessionWork.notify.turn') : t('sessionWork.notify.attention')}
        sets={props.read.sets} status={props.read.status} machineId={props.read.machineId}
        match={match} add={add} remove={props.read.remove} execute={props.execute} />;
}
