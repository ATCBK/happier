import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { CollectionNavigationRow, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { t } from '@/text';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { formatRelativeTimeShort, readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';
import { formatNextScheduledRunAccessibilityLabel, formatScheduledRunQualifier, formatTriggerLastOutcome, readNextScheduledRunRefreshAtMs, type ScheduledRunQualifierTime } from './formatTriggerSummary';
import type { WorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { HAPPIER_COLLECTION_LIST_METRICS, HappierTriggerRow, type HappierTriggerRowHost } from '@happier-dev/plugin-ui/presentation';

/**
 * One trigger, as every trigger list shows it (07 S16 owner-approved presentation, item 4; I4-W
 * §Handoff): named by what it runs, then one quiet line with its qualifier and last outcome, then
 * its switch. "Failed" takes the trouble tone; a turned-off row is dimmed and reads "Off", while its
 * switch keeps its full hit target.
 *
 * The row draws no divider, card or inset of its own: the enclosing sheet group owns them. In a
 * navigation column (`presentation="column"`) the same words take the column's row anatomy instead:
 * the event glyph in the rows' mark column, so a trigger lines up with the workflows beside it.
 */
export type TriggerRowOutcome = Readonly<{
    text: string;
    tone: WorkStatusTone;
    relativeAge?: Readonly<{ atMs: number; state?: string }>;
}>;

export type TriggerRowProps = Readonly<{
    testID: string;
    /** What it runs: a workflow's name or the inline Then ("Notify me → Discord"). */
    title: string;
    /** The qualifier ("Files changed", "When it needs you"), when there is one. */
    qualifier?: string | null;
    qualifierTime?: ScheduledRunQualifierTime;
    qualifierAccessibilityLabel?: string;
    /** Retained legacy content is not a one-line editable summary. */
    multiline?: boolean;
    outcome?: TriggerRowOutcome | null;
    /** Paused for an explicit review, not an ordinary user-disabled trigger. */
    attention?: string;
    enabled: boolean;
    /** Why the switch cannot change right now (a pending write, an unavailable writer). */
    toggleDisabled?: boolean;
    onToggle: (next: boolean) => void;
    /** Opens the trigger's popover; without it the row is information only. */
    onPress?: () => void;
    /** `column`: a row of a navigation column (the Workflows column's Triggers group). */
    presentation?: 'sheet' | 'column';
    /** The event's glyph; a column row leads with it like its sibling rows' marks. */
    glyph?: IconName;
    /** The row's own line under its words (History · Run now); the switch then closes that line. */
    actions?: React.ReactNode;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    off: { color: theme.colors.text.tertiary },
    // The habit's own line (History · Run now · switch) belongs to the row above it: it tucks into that
    // row's bottom padding so the quiet line and its actions read as one block (lab `b-habit T`),
    // while the switch keeps its full touch target.
    actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space.s4,
        marginTop: -theme.space.s12,
        paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingBottom: theme.space.s4 },
}));

const triggerRowHost: HappierTriggerRowHost = {
    Toggle: Switch,
    Text: ({ tone, ...props }) => <Text {...props} style={workStatusWordStyle(tone)} />,
    actionsStyle: stylesheet.actions,
    Row: (props) => props.presentation === 'column' && props.onPress ? (
        <CollectionNavigationRow testID={props.testID} title={props.title}
            {...(props.subtitleText ? { subtitle: props.subtitleText } : {})}
            {...(props.attention ? { subtitleLeading: <View style={collectionListStyles.troubleDot} /> } : {})}
            icon={props.icon} selected={false} rightElement={props.toggle} onPress={props.onPress} />
    ) : (
        <Item testID={props.testID} title={props.title} accessibilityLabel={props.accessibilityLabel}
            icon={props.icon} {...(props.multiline ? { titleLines: 0, subtitleLines: 0 } : {})}
            {...(props.subtitle ? { subtitle: props.subtitle } : {})}
            {...(props.attention ? { subtitleStyle: workStatusWordStyle('attention') }
                : props.enabled ? {} : { titleStyle: stylesheet.off, subtitleStyle: stylesheet.off })}
            {...(props.onPress ? { onPress: props.onPress } : { mode: 'info' as const })}
            showChevron={false} showDivider={false} rightElementOutsidePressable rightElement={props.toggle} />
    ),
};

export const TriggerRow = React.memo(function TriggerRow(props: TriggerRowProps) {
    const relativeAge = props.outcome?.relativeAge;
    const qualifierTime = props.attention ? undefined : props.qualifierTime;
    const readNextRefresh = React.useCallback((nowMs: number) => {
        const deadlines = [qualifierTime ? readNextScheduledRunRefreshAtMs(qualifierTime.atMs, nowMs) : null,
            relativeAge ? readRelativeTimeShortRefreshAtMs(relativeAge.atMs, nowMs) : null]
            .filter((at): at is number => at !== null);
        return deadlines.length === 0 ? null : Math.min(...deadlines);
    }, [qualifierTime, relativeAge]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, qualifierTime !== undefined || relativeAge !== undefined);
    const qualifier = qualifierTime
        ? formatScheduledRunQualifier(qualifierTime, nowMs, props.enabled)
        : props.qualifier;
    const lead = props.attention ?? (props.enabled
        ? qualifier ?? null
        : [t('workflows.triggers.row.off'), qualifier].filter(Boolean).join(' · '));
    const outcome = props.outcome === undefined || props.outcome === null ? null : relativeAge
        ? { ...props.outcome, text: formatTriggerLastOutcome(formatRelativeTimeShort(relativeAge.atMs, nowMs), relativeAge.state) }
        : props.outcome;
    return <HappierTriggerRow testID={props.testID} title={props.title} qualifier={lead}
        qualifierAccessibilityLabel={qualifierTime && props.qualifierAccessibilityLabel
            ? formatNextScheduledRunAccessibilityLabel(qualifierTime.atMs, props.enabled, nowMs)
            : props.qualifierAccessibilityLabel} outcome={outcome}
        enabled={props.enabled} attention={Boolean(props.attention)} toggleDisabled={props.toggleDisabled}
        toggleLabel={t(props.enabled ? 'workflows.triggers.row.turnOff' : 'workflows.triggers.row.turnOn', { name: props.title })}
        onToggle={props.onToggle} onPress={props.onPress} presentation={props.presentation} multiline={props.multiline}
        icon={props.glyph ? <Icon name={props.glyph} /> : undefined}
        actions={props.presentation === 'column' && props.onPress ? undefined : props.actions} host={triggerRowHost} />;
});
