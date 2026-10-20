import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import type { SessionArchiveActionResultV1 } from '@happier-dev/protocol/sessions/control/contract';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { getStorage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
import { selectSessionReportSubtree } from '@/components/sessions/work/reportSubtree';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

/**
 * The archive scope choice for a Session (ORC R-04, §3.1 "Archiving a lead").
 *
 * A Session that leads others offers "Also archive N sub-sessions", off by default; archiving a lead
 * never archives its reports unless the person ticks it. A Session with no reports proceeds directly;
 * approval is owned by the Action policy. Both the header menu and the row menu use this choice.
 */
export type SessionArchiveConfirmation = Readonly<{ confirmed: boolean; alsoArchiveReports: boolean }>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s16,
        gap: 14,
    },
    message: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    option: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s12,
    },
    optionLabel: {
        ...Typography.default(),
        flex: 1,
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.primary,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: theme.space.s8,
    },
}));

type SessionArchiveConfirmModalProps = CustomModalInjectedProps & Readonly<{
    reportCount: number;
    onResolve: (result: SessionArchiveConfirmation) => void;
}>;

export function SessionArchiveConfirmModal(props: SessionArchiveConfirmModalProps) {
    const styles = stylesheet;
    const [alsoArchiveReports, setAlsoArchiveReports] = React.useState(false);
    const resolvedRef = React.useRef(false);
    const { onClose, onResolve } = props;
    const finish = React.useCallback((confirmed: boolean) => {
        if (!resolvedRef.current) {
            resolvedRef.current = true;
            onResolve({ confirmed, alsoArchiveReports: confirmed && alsoArchiveReports });
        }
        onClose();
    }, [alsoArchiveReports, onClose, onResolve]);
    // Closing any other way (Esc, backdrop) is a cancel.
    React.useEffect(() => () => {
        if (!resolvedRef.current) {
            resolvedRef.current = true;
            onResolve({ confirmed: false, alsoArchiveReports: false });
        }
    }, [onResolve]);

    const footer = React.useMemo(() => (
        <View style={styles.footer}>
            <RoundButton testID="session-archive-cancel" display="secondary" size="normal" title={t('common.cancel')} onPress={() => finish(false)} />
            <RoundButton testID="session-archive-confirm" display="destructive" size="normal" title={t('sessionInfo.archiveSession')} onPress={() => finish(true)} />
        </View>
    ), [finish, styles.footer]);
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: t('sessionInfo.archiveSession'),
        testID: 'session-archive-confirm-modal',
        footer,
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.narrow, maxHeightRatio: 0.6, size: 'dialog' as const },
    }), [footer]);
    useModalCardChrome(props.setChrome, chrome);

    return (
        <View style={styles.body}>
            <Text style={styles.message}>{t('sessionInfo.archiveSessionConfirm')}</Text>
            <View style={styles.option}>
                <Text nativeID="session-archive-reports-label" style={styles.optionLabel}>
                    {t('sessionWork.archive.alsoArchiveReports', { count: props.reportCount })}
                </Text>
                <Switch
                    testID="session-archive-also-reports"
                    accessibilityLabel={t('sessionWork.archive.alsoArchiveReports', { count: props.reportCount })}
                    value={alsoArchiveReports}
                    onValueChange={setAlsoArchiveReports}
                />
            </View>
        </View>
    );
}

type SessionArchiveLead = Readonly<{ leadSessionId: string; serverId: string | null }>;

/**
 * A display-only estimate for the existing confirmation. The Action resolves current scope at execution;
 * this cached projection never selects mutation targets.
 */
function selectArchivableSessionReports(params: SessionArchiveLead): readonly Session[] {
    const state = getStorage().getState();
    return selectSessionReportSubtree(state.sessions, params.leadSessionId, params.serverId, state.sessionListRowsByServerId).filter((session) => (
        readSessionManagerSessionIdV1(session) === params.leadSessionId && session.archivedAt == null
    ));
}

export async function confirmSessionArchive(params: SessionArchiveLead): Promise<SessionArchiveConfirmation> {
    const reportCount = selectArchivableSessionReports(params).length;
    if (reportCount <= 0) {
        return { confirmed: true, alsoArchiveReports: false };
    }
    return await new Promise<SessionArchiveConfirmation>((resolve) => {
        Modal.show({
            component: SessionArchiveConfirmModal,
            props: { reportCount, onResolve: resolve },
        });
    });
}

/**
 * Presents partial outcomes returned by the canonical archive Action. Scope selection and every
 * report's mutation/approval belong to that owner, including reports this UI has never loaded.
 */
export async function archiveSessionReports(params: Pick<SessionArchiveActionResultV1, 'reports' | 'reportsError'> & Readonly<{ serverId?: string | null }>): Promise<void> {
    const state = getStorage().getState();
    const notArchived = (params.reports ?? []).filter(report => report.status !== 'archived')
        .map(report => {
            const known = params.serverId ? findSessionListLookupSession(state, {
                serverId: params.serverId, sessionId: report.sessionId,
            })?.session : null;
            return known ? getSessionName(known, params.serverId) : report.title || report.sessionId;
        });
    if (params.reportsError) {
        Modal.alert(t('common.error'), [t('sessionInfo.failedToArchiveSession'), ...notArchived].join('\n'));
        return;
    }
    if (notArchived.length > 0) {
        Modal.alert(
            t('sessionWork.archive.someNotArchivedTitle', { count: notArchived.length }),
            notArchived.join('\n'),
        );
    }
}
