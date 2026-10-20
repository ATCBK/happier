import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
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
import { selectSessionReportSubtree } from '@/components/sessions/work/reportSubtree';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import { SESSION_ACTION_ARCHIVE_ID } from './sessionActionIds';
import { createSessionActionTarget } from './sessionActionContext';
import { executeSessionAction } from './sessionActionExecution';
import type { SessionActionExecutionContext } from './sessionActionTypes';

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
 * The direct reports archiving a lead can still change: the one set the confirmation counts and the
 * cascade archives. An already archived report is history, not something Archive would do to it, so it is
 * neither offered nor counted.
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
 * Archives a lead's direct reports after the person ticked "Also archive N sub-sessions": the existing
 * archive Action once per report, in order. A report that cannot be archived (no archive right, a
 * refused stop) does not stop the others; the reports left unarchived are named afterwards.
 */
export async function archiveSessionReports(params: Readonly<{
    leadSessionId: string;
    serverId: string | null;
    context?: SessionActionExecutionContext;
}>): Promise<void> {
    const reports = selectArchivableSessionReports(params);
    const notArchived: string[] = [];
    for (const report of reports) {
        const serverId = params.serverId;
        try {
            await executeSessionAction({
                actionId: SESSION_ACTION_ARCHIVE_ID,
                target: createSessionActionTarget({ session: report, serverId }),
                ...(params.context ? { context: params.context } : {}),
            });
        } catch {
            notArchived.push(getSessionName(report, serverId));
        }
    }
    if (notArchived.length > 0) {
        Modal.alert(
            t('sessionWork.archive.someNotArchivedTitle', { count: notArchived.length }),
            notArchived.join('\n'),
        );
    }
}
