import { Typography } from '@/constants/Typography';
import * as React from 'react';
import {
    View,
    useWindowDimensions,
} from 'react-native';
import {
    StyleSheet,
    useUnistyles,
} from 'react-native-unistyles';

import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { SelectionList, type SelectionListOption, type SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { readSessionListMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListOrderingRules';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { useSessionListIndexByServerId, useSessionListRowRenderablesForItems, useSessions } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionRowPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { t } from '@/text';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { getSessionName, getSessionStatus, getSessionSubtitle } from '@/utils/sessions/sessionUtils';

import { resolveReadableSessionPickerTargets, resolveTranscriptSendToSessionTargets } from './resolveTranscriptSendToSessionTargets';
import {
    resolveTranscriptSendToSessionModalLayout,
    TRANSCRIPT_SEND_TO_SESSION_MODAL_SIZE,
    TRANSCRIPT_SEND_TO_SESSION_MODAL_WIDTH,
} from './resolveTranscriptSendToSessionModalLayout';
import type { SendTranscriptSelectionDestination } from './sendTranscriptSelectionToSession';
import { Icon } from '@/components/ui/icons/Icon';

export type TranscriptSendToSessionModalProps = CustomModalInjectedProps & Readonly<{
    sourceServerId: string;
    onResolve: (destination: SendTranscriptSelectionDestination | null) => void;
}> & (Readonly<{ selectionOnly: true; sourceSessionId?: never; previewText?: never }>
    | Readonly<{ selectionOnly?: false; sourceSessionId: string; previewText: string }>);

const styles = StyleSheet.create((theme) => ({
    body: {
        flex: 1,
        minHeight: 0,
    },
    newSessionIcon: {
        width: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sessionMeta: {
        alignItems: 'flex-end',
        gap: theme.space.s2,
        marginLeft: theme.space.s12,
        minWidth: 48,
        maxWidth: 128,
    },
    sessionStatus: {
        ...Typography.variant('meta', 'semiBold'),
    },
    sessionActivity: {
        color: theme.colors.text.secondary,
        fontSize: 11,
    },
}));

type TranscriptSendToSessionTargetSource = Session | SessionListRenderableSession;
type TranscriptSendToSessionTarget = TranscriptSendToSessionTargetSource & Readonly<{ serverId: string }>;

const NEW_SESSION_DESTINATION_ID = 'new-session';

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function appendTranscriptSendToTarget(
    targets: TranscriptSendToSessionTarget[],
    seenTargetKeys: Set<string>,
    session: TranscriptSendToSessionTargetSource,
    rawServerId: unknown,
): void {
    const sessionId = normalizeNonEmptyString(session.id);
    const serverId = normalizeNonEmptyString(rawServerId);
    if (!sessionId || !serverId) return;

    const targetKey = sessionAddressKey({ serverId, sessionId });
    if (seenTargetKeys.has(targetKey)) return;
    seenTargetKeys.add(targetKey);
    targets.push({ ...session, serverId });
}

function readSessionListIndexSessionItems(
    sessionListIndexByServerId: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>,
): Extract<SessionListIndexItem, { type: 'session' }>[] {
    const out: Extract<SessionListIndexItem, { type: 'session' }>[] = [];
    for (const [recordServerId, items] of Object.entries(sessionListIndexByServerId)) {
        const serverId = normalizeNonEmptyString(recordServerId);
        if (!serverId || !Array.isArray(items)) continue;

        for (const item of items) {
            if (item.type !== 'session') continue;
            out.push(item.serverId ? item : { ...item, serverId });
        }
    }
    return out;
}

function appendSessionListTargets(
    targets: TranscriptSendToSessionTarget[],
    seenTargetKeys: Set<string>,
    sessionListItems: ReadonlyArray<Extract<SessionListIndexItem, { type: 'session' }>>,
    sessionListRowRenderablesByKey: ReadonlyMap<string, SessionListRenderableSession>,
): void {
    for (const item of sessionListItems) {
        const serverId = normalizeNonEmptyString(item.serverId);
        const sessionId = normalizeNonEmptyString(item.sessionId);
        if (!serverId || !sessionId) continue;
        const renderable = sessionListRowRenderablesByKey.get(sessionAddressKey({ serverId, sessionId }));
        if (!renderable) continue;
        appendTranscriptSendToTarget(targets, seenTargetKeys, renderable, serverId);
    }
}

/** Empty when the target Session's Agent is unknown; the icon then shows its neutral mark. */
function resolveSessionAgentId(session: TranscriptSendToSessionTargetSource): string {
    return readSessionRowPresentationAgentId(session) ?? '';
}

const TranscriptSendToSessionRowMeta = React.memo(function TranscriptSendToSessionRowMeta(
    props: Readonly<{ session: TranscriptSendToSessionTarget }>,
) {
    const { theme } = useUnistyles();
    const nowMs = Date.now();
    const status = getSessionStatus(props.session, nowMs, {
        workingTextMode: 'static',
        statusColors: theme.colors.status,
    });
    const activityAt = readSessionListMeaningfulActivityAt(props.session);
    const activityLabel = activityAt > 0 ? formatShortRelativeTimeAt(activityAt, nowMs) : '';

    return (
        <View testID={`transcript-send-to-session-meta-${props.session.id}`} style={styles.sessionMeta}>
            <Text style={[styles.sessionStatus, { color: status.statusColor }]} numberOfLines={1}>
                {status.statusText}
            </Text>
            {activityLabel ? (
                <Text style={styles.sessionActivity} numberOfLines={1}>
                    {activityLabel}
                </Text>
            ) : null}
        </View>
    );
});

export const TranscriptSendToSessionModal = React.memo(function TranscriptSendToSessionModal(
    props: TranscriptSendToSessionModalProps,
) {
    const { theme } = useUnistyles();
    const sessions = useSessions() ?? [];
    const windowDimensions = useWindowDimensions();
    const keyboardHeight = useKeyboardHeight();
    const title = props.selectionOnly ? t('sessionGettingStarted.title.selectSession') : t('transcript.selection.sendTo.modalTitle');
    const modalLayout = React.useMemo(() => resolveTranscriptSendToSessionModalLayout({
        windowWidth: windowDimensions.width,
        windowHeight: windowDimensions.height,
        keyboardHeight,
    }), [keyboardHeight, windowDimensions.height, windowDimensions.width]);
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title,
        ...(props.selectionOnly ? {} : { subtitle: t('transcript.selection.sendTo.modalSubtitle') }),
        dimensions: {
            width: TRANSCRIPT_SEND_TO_SESSION_MODAL_WIDTH,
            maxHeightRatio: modalLayout.maxHeightRatio,
            size: TRANSCRIPT_SEND_TO_SESSION_MODAL_SIZE,
        },
    }), [modalLayout.maxHeightRatio, props.selectionOnly, title]);
    useModalCardChrome(props.setChrome, chrome);

    const sourceServerId = props.sourceServerId.trim();
    const sourceServerIds = React.useMemo(() => sourceServerId ? [sourceServerId] : [], [sourceServerId]);
    const sessionListIndexByServerId = useSessionListIndexByServerId(sourceServerIds);
    const sessionListItems = React.useMemo(
        () => readSessionListIndexSessionItems(sessionListIndexByServerId),
        [sessionListIndexByServerId],
    );
    const sessionListRowRenderablesByKey = useSessionListRowRenderablesForItems(sessionListItems);
    const targets = React.useMemo<ReadonlyArray<TranscriptSendToSessionTarget>>(() => {
        const candidates: TranscriptSendToSessionTarget[] = [];
        const seenTargetKeys = new Set<string>();
        appendSessionListTargets(candidates, seenTargetKeys, sessionListItems, sessionListRowRenderablesByKey);
        for (const session of sessions) {
            appendTranscriptSendToTarget(
                candidates,
                seenTargetKeys,
                session,
                session.serverId ?? resolveServerIdForSessionIdFromLocalCache(session.id),
            );
        }
        return (props.selectionOnly ? resolveReadableSessionPickerTargets({ serverId: sourceServerId, sessions: candidates }) : resolveTranscriptSendToSessionTargets({
            sourceSessionId: props.sourceSessionId,
            sourceServerId,
            sessions: candidates,
        })) as ReadonlyArray<TranscriptSendToSessionTarget>;
    }, [props.selectionOnly, props.sourceSessionId, sessions, sessionListItems, sessionListRowRenderablesByKey, sourceServerId]);

    const onResolve = props.onResolve;
    const onClose = props.onClose;
    const options = React.useMemo<ReadonlyArray<SelectionListOption>>(() => [
        ...(props.selectionOnly ? [] : [{
            id: NEW_SESSION_DESTINATION_ID,
            testID: 'transcript-send-to-session-option-new-session',
            label: t('transcript.selection.sendTo.newSession'),
            subtitle: t('transcript.selection.sendTo.newSessionSubtitle'),
            icon: (
                <View style={styles.newSessionIcon}>
                    <Icon name="plus-circle" size={20} color={theme.colors.text.secondary} />
                </View>
            ),
        }]),
        ...targets.map((session) => ({
            id: session.id,
            testID: `transcript-send-to-session-option-${session.id}`,
            label: getSessionName(session),
            subtitle: getSessionSubtitle(session),
            icon: (
                <SessionAgentCatalogIdentityIcon
                    agentId={resolveSessionAgentId(session)}
                    machineId={normalizeNonEmptyString(session.metadata?.machineId)}
                    serverId={session.serverId}
                    size={20}
                    color={theme.colors.text.secondary}
                    testID={`transcript-send-to-session-agent-logo-${session.id}`}
                />
            ),
            rightAccessory: <TranscriptSendToSessionRowMeta session={session} />,
        })),
    ], [props.selectionOnly, targets, theme.colors.text.secondary]);

    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: 'transcript-send-to-session-root',
        title,
        inputPlaceholder: t('transcript.selection.sendTo.searchPlaceholder'),
        emptyStateLabel: t('transcript.selection.sendTo.noResults'),
        sections: [
            {
                kind: 'static',
                id: 'sessions',
                options,
                virtualization: 'auto',
            },
        ],
    }), [options, title]);

    return (
        <View testID="transcript-send-to-session-modal-body" style={styles.body}>
            <SelectionList
                testID="transcript-send-to-session-list"
                rootStep={rootStep}
                onSelect={(id) => {
                    if (!props.selectionOnly && id === NEW_SESSION_DESTINATION_ID) {
                        onResolve({ kind: 'newSession' });
                        onClose();
                        return;
                    }
                    const selected = targets.find((target) => target.id === id);
                    onResolve(selected ? { kind: 'existingSession', sessionId: selected.id, serverId: selected.serverId } : null);
                    onClose();
                }}
                onRequestClose={() => {
                    onResolve(null);
                    onClose();
                }}
                autoFocusInputOnWeb
                keyboardHintsEnabled
                maxHeight={modalLayout.listMaxHeight}
                heightBehavior="fixedToMaxHeight"
                showsVerticalScrollIndicator
            />
        </View>
    );
});
