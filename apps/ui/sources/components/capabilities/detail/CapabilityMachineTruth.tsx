import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { ExpandableItem, ExpandableItemCaret } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type CapabilityMachineTruthRow = Readonly<{
    machineId: string;
    machineName: string;
    deviceIcon: IconName;
    /** "macOS", "Linux": a quiet qualifier after the name. */
    os?: string;
    /** What it looks like there ("41 tools · checked 10:31", the Agents that get it). */
    who: React.ReactNode;
    /** A quiet dated line at the end ("last known Oct 9"). */
    note?: string;
    status?: CapabilityStatus | null;
    /** An offline machine reads dimmed; its last-known facts stay. */
    offline?: boolean;
}>;

/**
 * "On your machines" (P5 detail grammar): what a capability looks like on each of the Account's
 * machines. Closed, one summary ("Ready on 2 · offline 1"); open, one row per machine with its own
 * status and fix. The consumer supplies the words and the one section operation (Test, Check now).
 */
export function CapabilityMachineTruth(props: Readonly<{
    rows: readonly CapabilityMachineTruthRow[];
    /** The closed line: one line that shortens with an ellipsis when the room is short. */
    summary: string;
    /** Kept whole after the summary ("2 offline"), so the ellipsis never takes it. */
    summaryNote?: string;
    description?: string;
    sectionAction?: Readonly<{ label: string; onPress: () => void; busy?: boolean; icon?: IconName }>;
    /** Open on arrival (a machine needs the person). */
    defaultExpanded?: boolean;
    /** What the section says when it is on no machine (default: "No machines yet"). */
    emptyLabel?: string;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(props.defaultExpanded === true);
    const action = props.sectionAction;
    return (
        <ItemGroup
            testID={props.testID}
            title={t('capabilities.detail.onYourMachines')}
            description={props.description}
            action={action ? (
                <RoundButton
                    testID={`${props.testID}:action`}
                    size="small"
                    display="inverted"
                    title={action.label}
                    leading={action.icon ? <Icon name={action.icon} size={14} color={theme.colors.text.primary} /> : undefined}
                    loading={action.busy}
                    disabled={action.busy}
                    onPress={action.onPress}
                />
            ) : undefined}
        >
            {props.rows.length === 0 ? (
                <Item testID={`${props.testID}:none`} title={props.emptyLabel ?? t('capabilities.detail.noMachines')} showChevron={false} />
            ) : (
                <ExpandableItem
                    testID={`${props.testID}:disclosure`}
                    expanded={expanded}
                    onExpandedChange={setExpanded}
                    showDivider={false}
                    header={({ headerProps, expanded: open }) => (
                        <Item
                            {...(headerProps as Readonly<Record<string, unknown>>)}
                            testID={`${props.testID}:summary`}
                            title={t('capabilities.detail.byMachine')}
                            leftElement={<ExpandableItemCaret expanded={open} />}
                            rightElement={open ? null : (
                                <View style={styles.summaryLine}>
                                    <Text variant="meta" numberOfLines={1} style={styles.summaryText}>{props.summary}</Text>
                                    {props.summaryNote ? <Text variant="meta" numberOfLines={1} style={styles.summaryNote}>{`· ${props.summaryNote}`}</Text> : null}
                                </View>
                            )}
                            showChevron={false}
                        />
                    )}
                >
                    {expanded ? props.rows.map((row) => (
                        <Item
                            key={row.machineId}
                            testID={`${props.testID}:machine:${row.machineId}`}
                            title={row.machineName}
                            titleQualifier={row.os ?? null}
                            titleStyle={row.offline ? styles.offline : undefined}
                            subtitle={row.who}
                            subtitleLines={1}
                            icon={<Icon name={row.deviceIcon} size={20} color={row.offline ? theme.colors.text.tertiary : theme.colors.text.secondary} />}
                            rightElement={row.status || row.note ? (
                                <View style={styles.end}>
                                    {row.status ? <CapabilityStatusChip status={row.status} showFix testID={`${props.testID}:machine:${row.machineId}:status`} /> : null}
                                    {row.note ? <Text variant="meta" style={styles.note} testID={`${props.testID}:machine:${row.machineId}:note`}>{row.note}</Text> : null}
                                </View>
                            ) : undefined}
                            accessoryLayout="adaptive"
                            showChevron={false}
                        />
                    )) : null}
                </ExpandableItem>
            )}
        </ItemGroup>
    );
}

const styles = StyleSheet.create((theme) => ({
    summaryLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, minWidth: 0, flexShrink: 1 },
    summaryText: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'], flexShrink: 1, minWidth: 0 },
    summaryNote: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'], flexShrink: 0 },
    end: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' },
    note: { color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
    offline: { color: theme.colors.text.secondary },
}));
