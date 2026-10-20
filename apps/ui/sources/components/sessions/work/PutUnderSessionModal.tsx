import * as React from 'react';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SelectionList } from '@/components/ui/selectionList/SelectionList';
import type { SelectionListStep } from '@/components/ui/selectionList/_types';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { getStorage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { setSessionManager } from '@/sync/ops/relations/setSessionManager';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import { loadSessionManagerEligibility, type SessionManagerEligibilitySnapshot } from '@/sync/ops/relations/sessionManagerEligibility';

import { describeManagerRefusal } from './putSessionUnderLead';
import { buildPutUnderChooserSections, PUT_UNDER_TOP_LEVEL_OPTION_ID } from './putUnderChooser';
import { resolvePutUnderEligibility } from './putUnderCandidates';
import { describeSessionListDropReason } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';
import { selectSessionRelationRecords } from './reportSubtree';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

/**
 * "Put under…" (ORC §3.8, R-03; DnD lab K1c): the keyboard, phone and screen-reader equivalent of
 * dragging a Session under a lead. It asks the Home once for the relation facts, lists the Sessions
 * that can lead this one and, under "Can't take reports", the ones that cannot with the owner's
 * reason, and asks the one `session.manager.set` Action with the lead it saw as the expected
 * current lead. The server's fence and compare-and-set decide; a refusal is said in words.
 */

const stylesheet = StyleSheet.create(() => ({
    body: {
        minHeight: 320,
        maxHeight: 520,
    },
    // The refusal sits under the list, so nothing above it moves when it appears.
    status: {
        paddingHorizontal: 16,
        paddingBottom: 12,
    },
}));

type PutUnderSessionModalProps = CustomModalInjectedProps & Readonly<{
    sessionId: string;
    serverId: string | null;
}>;

export function PutUnderSessionModal(props: PutUnderSessionModalProps) {
    const styles = stylesheet;
    const { onClose } = props;
    const onCloseRef = React.useRef(onClose);
    onCloseRef.current = onClose;
    const close = React.useCallback(() => onCloseRef.current(), []);
    const [error, setError] = React.useState<string | null>(null);
    // The lead being asked for, shown pending on its own row until the Home answers.
    const [pendingId, setPendingId] = React.useState<string | null>(null);
    const busy = pendingId !== null;
    // A snapshot taken when the sheet opens: the choice is made against what the person saw.
    const [snapshot] = React.useState(() => {
        const state = getStorage().getState();
        const sessions = selectSessionRelationRecords(state.sessions, props.serverId, state.sessionListRowsByServerId);
        const self = sessions[props.sessionId] ?? null;
        return { sessions, currentLeadId: readSessionManagerSessionIdV1(self),
            sessionId: props.sessionId, serverId: props.serverId,
            lifetime: captureActiveServerAccountScopeLifetime() };
    });
    React.useEffect(() => {
        if (!snapshot.lifetime || snapshot.lifetime.scope.serverId !== snapshot.serverId || !snapshot.lifetime.isCurrent()) {
            close();
            return;
        }
        const retirement = snapshot.lifetime.onRetire(close);
        return () => retirement.dispose();
    }, [close, snapshot]);
    // One relation-facts batch per open; `undefined` while the Home is being asked.
    const [facts, setFacts] = React.useState<SessionManagerEligibilitySnapshot | null | undefined>(undefined);
    React.useEffect(() => {
        if (!props.serverId || !snapshot.lifetime?.isCurrent() || snapshot.lifetime.scope.serverId !== props.serverId) {
            setFacts(null);
            return;
        }
        const abort = new AbortController();
        let loaded: SessionManagerEligibilitySnapshot | null = null;
        const candidateSessionIds = Object.values(snapshot.sessions)
            .filter((session) => (session.serverId ?? null) === props.serverId && session.id !== props.sessionId)
            .map((session) => session.id);
        void loadSessionManagerEligibility({
            serverId: props.serverId,
            sessionId: props.sessionId,
            candidateSessionIds,
            signal: abort.signal,
        }).then((next) => {
            if (abort.signal.aborted) {
                next?.dispose();
                return;
            }
            if (!snapshot.lifetime?.isCurrent() || (next && (!next.isCurrent()
                || next.serverId !== snapshot.serverId || next.accountId !== snapshot.lifetime.scope.accountId))) {
                next?.dispose();
                close();
                return;
            }
            loaded = next;
            setFacts(next);
        });
        return () => {
            abort.abort();
            loaded?.dispose();
        };
    }, [close, props.serverId, props.sessionId, snapshot]);

    const step = React.useMemo<SelectionListStep>(() => {
        const sections = facts === undefined ? [] : buildPutUnderChooserSections({
            sessions: snapshot.sessions,
            sessionId: props.sessionId,
            facts,
            describeName: (session) => getSessionName(session, session.serverId ?? null),
        });
        return {
            id: 'leads',
            inputPlaceholder: t('sessionWork.putUnder.search'),
            sections: sections.map((section) => ({
                kind: 'static' as const,
                id: section.id,
                ...(section.title ? { title: section.title } : {}),
                options: section.options.map((option) => ({
                    id: option.id,
                    label: option.label,
                    ...(option.detail ? { subtitle: option.detail } : {}),
                    ...(option.disabled || (pendingId !== null && pendingId !== option.id) ? { disabled: true } : {}),
                    ...(pendingId === option.id ? { loading: true } : {}),
                })),
            })),
        };
    }, [facts, pendingId, props.sessionId, snapshot.sessions]);

    const onSelect = React.useCallback((optionId: string) => {
        if (busy) return;
        const state = getStorage().getState();
        const sessions = selectSessionRelationRecords(state.sessions, props.serverId, state.sessionListRowsByServerId);
        const self = sessions[props.sessionId];
        if (!snapshot.lifetime?.isCurrent() || props.serverId !== snapshot.serverId || props.sessionId !== snapshot.sessionId
            || !self || (self.serverId ?? null) !== snapshot.serverId) {
            onClose();
            return;
        }
        if (!facts?.isCurrent() || facts.serverId !== snapshot.serverId || facts.accountId !== snapshot.lifetime.scope.accountId
            || facts.sessionId !== snapshot.sessionId || facts.currentManagerSessionId !== snapshot.currentLeadId
            || readSessionManagerSessionIdV1(self) !== snapshot.currentLeadId) {
            setError(describeSessionListDropReason('unavailable').message);
            return;
        }
        const managerSessionId = optionId === PUT_UNDER_TOP_LEVEL_OPTION_ID ? null : optionId;
        if (managerSessionId !== null) {
            const eligibility = resolvePutUnderEligibility(sessions, props.sessionId, managerSessionId, facts, {
                serverId: snapshot.serverId, accountId: snapshot.lifetime.scope.accountId, allowCurrentLead: true,
            });
            if (!eligibility.allowed) {
                setError(describeSessionListDropReason(eligibility.reason).message);
                return;
            }
        } else if (self.archivedAt != null || self.access?.capabilities.readTranscript !== true
            || self.access.capabilities.submitAgentInput !== true) {
            setError(describeSessionListDropReason('unavailable').message);
            return;
        }
        if (managerSessionId === snapshot.currentLeadId) {
            onClose();
            return;
        }
        setPendingId(optionId);
        setError(null);
        void setSessionManager({
            sessionId: props.sessionId,
            managerSessionId,
            expectedManagerSessionId: snapshot.currentLeadId,
            serverId: props.serverId,
            expectedAccountId: snapshot.lifetime.scope.accountId,
        }).then((result) => {
            if (result.ok) {
                onClose();
                return;
            }
            setPendingId(null);
            setError(describeManagerRefusal(result.errorCode));
        }, () => {
            setPendingId(null);
            setError(describeManagerRefusal(undefined));
        });
    }, [busy, facts, onClose, props.serverId, props.sessionId, snapshot]);

    // Lab K1c: the sheet names what it moves ("Put Review #2481 under…").
    const title = React.useMemo(() => {
        const self = snapshot.sessions[props.sessionId];
        return self ? t('entityDragDrop.chooser.putUnderTitle', { item: getSessionName(self, self.serverId ?? null) }) : t('sessionWork.putUnder.title');
    }, [props.sessionId, snapshot.sessions]);
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title,
        testID: 'session-put-under-modal',
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.default, maxHeightRatio: 0.8, size: 'dialog' as const },
    }), [title]);
    useModalCardChrome(props.setChrome, chrome);

    return (
        <View style={styles.body}>
            <SelectionList
                rootStep={step}
                selectedOptionId={snapshot.currentLeadId}
                listAccessibilityLabel={title}
                fillAvailableSpace
                onSelect={onSelect}
                onRequestClose={onClose}
                testID="session-put-under-list"
                // While the Home is asked for the relation facts, say so instead of an empty list.
                {...(facts === undefined ? { contentState: (
                    <SurfaceStateCard testID="session-put-under-loading" kind="loading" size="line" title={t('entityDragDrop.chooser.checking')} />
                ) } : {})}
            />
            {error ? (
                <View style={styles.status}>
                    <SurfaceStateCard testID="session-put-under-error" kind="error" size="line" title={error} accessibilitySemantics="alert" />
                </View>
            ) : null}
        </View>
    );
}

export function showPutUnderSessionModal(params: Readonly<{ sessionId: string; serverId: string | null }>): void {
    Modal.show({ component: PutUnderSessionModal, props: params });
}
