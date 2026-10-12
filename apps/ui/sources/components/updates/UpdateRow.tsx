import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import type { AgentId } from '@/agents/catalog/catalog';
import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ITEM_ROW_PADDING_HORIZONTAL, resolveItemTextColumnInset } from '@/components/ui/lists/itemDensityMetrics';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import type { UpdateItem } from '@/updates/items/updateItem';

import { describeUpdateItem } from './describeUpdateItem';
import { UpdatesTextButton } from './UpdatesTextButton';

export type UpdateRowPresentation = 'popover' | 'screen';

/** The glyph a row (or the popover's row for this app) is marked with. */
export function resolveUpdateItemIconName(item: UpdateItem): IconName {
    if (item.subject.kind === 'happier-cli') return 'terminal';
    if (item.subject.kind === 'installable') {
        const key = item.subject.key;
        const entry = getInstallablesRegistryEntries().find((candidate) => candidate.key === key);
        return (entry?.iconName ?? 'cube') as IconName;
    }
    if (isDesktopHost()) return 'desktop';
    return Platform.OS === 'web' ? 'globe' : 'device-mobile';
}

/**
 * One update row, identical in both densities: identity on the left, one status line, and a
 * fixed-width action slot on the right that resolves in place (Update → spinner / percent → Retry)
 * while the title and icon never move. Its words come from `describeUpdateItem`; its state from
 * the item's producer. Progress shows only when the producer reports a real fraction.
 */
export const UpdateRow = React.memo(function UpdateRow(props: Readonly<{
    item: UpdateItem;
    /** Where the row lives, for labels that must name the object ("Update Codex on Studio"). */
    where: string;
    presentation: UpdateRowPresentation;
    /** When "Update all" is the one primary action, row buttons render as secondary. */
    secondaryAction: boolean;
    onRun: (item: UpdateItem) => void;
    onLongPress?: () => void;
    showDivider?: boolean;
    /** The row lives on this computer, where the desktop app can open its log file. */
    isThisComputer?: boolean;
    /** Sessions are running on the row's machine now (a quiet note on service-restarting rows). */
    sessionsRunning?: boolean;
}>) {
    const { theme } = useUnistyles();
    const serverId = useActiveServerSnapshot().serverId;
    const { execute: executeAction } = useMountedActionExecution(serverId);
    const { item } = props;
    const compact = props.presentation === 'popover';
    const presentation = describeUpdateItem(item, { sessionsRunning: props.sessionsRunning });
    const iconSize = compact ? ICON_SIZE.sm : ICON_SIZE.xl;
    const onRun = props.onRun;
    const run = React.useCallback(() => {
        if (Platform.OS === 'ios' || Platform.OS === 'android') hapticsLight();
        onRun(item);
    }, [item, onRun]);

    const icon = item.subject.kind === 'agent-cli'
        // Brand marks are drawn full-bleed; one step smaller matches the glyphs' optical ink.
        ? <AgentIcon agentId={item.subject.agentId as AgentId} size={compact ? ICON_SIZE.sm : ICON_SIZE.lg} />
        : <Icon name={resolveUpdateItemIconName(item)} size={iconSize} color={theme.colors.text.secondary} />;

    const percent = item.state === 'running' ? item.progressPercent : null;
    const canOpenLog = props.isThisComputer === true && isDesktopHost();
    const logPath = item.logPath ?? null;
    const copyFeedback = useTemporaryCopyFeedback();
    const markCopied = copyFeedback.markCopied;
    // A quiet secondary action of the failed row: on this computer the desktop app opens the log;
    // elsewhere the log lives on that machine, so its path is copied (with the copied feedback).
    const viewLog = React.useCallback(() => {
        if (!logPath) return;
        if (canOpenLog) {
            fireAndForget(executeAction('relay.runtime.open_path', { path: logPath }), { tag: 'UpdateRow.openLog' });
            return;
        }
        fireAndForget(executeAction('clipboard.write', { text: logPath }).then((result) => {
            if (result.ok && typeof result.result === 'object' && result.result !== null
                && 'status' in result.result && result.result.status === 'copied') markCopied(logPath);
        }), { tag: 'UpdateRow.copyLogPath' });
    }, [canOpenLog, executeAction, logPath, markCopied]);
    const showViewLog = !compact && item.state === 'failed' && logPath != null;
    const rowLabel = t('updates.a11y.rowOn', { title: item.title, where: props.where });
    const actionLabel = presentation.actionLabel;

    // A fixed box for every state of the slot (Update → spinner/percent → ✓ or Retry): it is laid
    // out by the widest label this row can show, so no state moves the title. The swap itself is
    // instant (0.3 has no rectangular status-settle primitive).
    const slot = (
        <View style={styles.slot} testID={`updates.row.${item.id}.slot`}>
            <View
                style={styles.slotSizing}
                pointerEvents="none"
                aria-hidden
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            >
                <RoundButton size="small" title={presentation.sizingLabel} display="inverted" disabled />
            </View>
            <View style={styles.slotContent}>
                {actionLabel ? (
                    <RoundButton
                        size="small"
                        title={actionLabel}
                        display={props.secondaryAction ? 'inverted' : 'default'}
                        onPress={run}
                        testID={`updates.row.${item.id}.action`}
                        accessibilityLabel={t('updates.a11y.actionOn', { action: actionLabel, title: item.title, where: props.where })}
                    />
                ) : item.state === 'running' ? (
                    percent != null ? (
                        <Text style={[styles.percent, compact ? styles.percentCompact : null, Typography.tabular()]}>{`${percent}%`}</Text>
                    ) : (
                        <ActivitySpinner size={iconMatchedSpinnerSize(ICON_SIZE.sm)} style={styles.spinner} testID={`updates.row.${item.id}.spinner`} />
                    )
                ) : item.state === 'upToDate' ? (
                    <Icon name="check" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                ) : null}
            </View>
        </View>
    );

    return (
        <View style={styles.row} testID={`updates.row.${item.id}`} accessibilityState={{ busy: item.state === 'running' }}>
            <Item
                title={item.title}
                subtitle={[presentation.subtitle, presentation.note, presentation.command].filter(Boolean).join('\n')}
                subtitleLines={0}
                icon={icon}
                density={compact ? 'compact' : undefined}
                rightElement={showViewLog ? (
                    <View style={styles.actions}>
                        {copyFeedback.isCopied(logPath ?? '') ? (
                            <CopiedPill visible testID={`updates.row.${item.id}.viewLog.copied`} />
                        ) : (
                            <UpdatesTextButton
                                label={t('updates.action.viewLog')}
                                accessibilityLabel={t('updates.a11y.actionOn', { action: t('updates.action.viewLog'), title: item.title, where: props.where })}
                                onPress={viewLog}
                                testID={`updates.row.${item.id}.viewLog`}
                            />
                        )}
                        {slot}
                    </View>
                ) : slot}
                showChevron={false}
                mode="info"
                copy={presentation.command ?? undefined}
                onLongPress={props.onLongPress}
                showDivider={props.showDivider}
                accessibilityLabel={[rowLabel, presentation.subtitle, presentation.note].filter(Boolean).join(', ')}
            />
            {percent != null ? (
                <View style={[styles.hairline, compact ? styles.hairlineCompact : styles.hairlineComfortable]} pointerEvents="none">
                    <MeterBar
                        tone="neutral"
                        height={2}
                        fillFraction={percent / 100}
                        trackColor={theme.colors.border.default}
                        progressAccessibilityLabel={t('updates.a11y.progress', { percent })}
                    />
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        position: 'relative',
    },
    slot: {
        position: 'relative',
        justifyContent: 'center',
    },
    slotSizing: {
        opacity: 0,
    },
    slotContent: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    // The spinner centres itself by default; in the slot it sits on the same right edge as the
    // check and the percent, so the mark does not jump sideways between states.
    spinner: {
        alignSelf: 'flex-end',
    },
    percent: {
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 15, default: 14 }),
    },
    percentCompact: {
        fontSize: Platform.select({ ios: 14, default: 13 }),
    },
    hairline: {
        position: 'absolute',
        bottom: 0,
    },
    // Starts under the title's text column, not under the icon: row padding + icon box + gap.
    hairlineCompact: {
        left: resolveItemTextColumnInset('compact'),
        right: ITEM_ROW_PADDING_HORIZONTAL.compact,
    },
    hairlineComfortable: {
        left: resolveItemTextColumnInset('comfortable'),
        right: ITEM_ROW_PADDING_HORIZONTAL.comfortable,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
    },
}));
