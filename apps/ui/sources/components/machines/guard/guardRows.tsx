import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PolicyValueSelect } from '@/components/machines/policy/PolicyValueSelect';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * The Guard's three row kinds in the Settings anatomy (lab `rg` G2): a rule's switch row, whose subtitle
 * says the rule's current state (or why a save did not land), a value row whose bordered select lists
 * the presets and ends with Custom… (R43), and a choice row of two to four segments. A row that cannot
 * change says its value as text (G9 2, 3). `awaiting` says a saved value the machine hasn't applied yet
 * (the rules are the saved settings; only the machine's own answer says what runs there).
 */

export function GuardSwitchRow(props: Readonly<{
    testID: string;
    title: string;
    subtitle: string;
    value: boolean;
    editable: boolean;
    failed: string | null;
    awaiting?: string | null;
    onToggle: (value: boolean) => void;
    bottomElement?: React.ReactNode;
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
    return (
        <Item testID={props.testID} title={props.title} subtitle={props.failed ?? props.awaiting ?? props.subtitle} mode="info" showDivider={props.showDivider}
            subtitleStyle={props.failed ? { color: theme.colors.state.danger.textForeground } : undefined}
            rightElement={props.editable || props.failed ? (
                <Switch testID={`${props.testID}-switch`} value={props.value} disabled={!props.editable} accessibilityLabel={props.title}
                    onValueChange={props.onToggle} />
            ) : <ReadOnlyValue text={props.value ? t('machineGuard.on') : t('machineGuard.off')} />}
            bottomElement={props.bottomElement} />
    );
}

export function ReadOnlyValue(props: Readonly<{ text: string; quiet?: boolean }>) {
    return <Text style={[styles.value, props.quiet ? styles.quiet : null]}>{props.text}</Text>;
}

export type GuardChoice<T> = Readonly<{ value: T; title: string }>;

export function GuardSelectRow<T extends string | number | null>(props: Readonly<{
    testID: string;
    title: string;
    subtitle: string;
    /** The select's accessible name ("Stop after"). */
    label: string;
    value: T;
    format: (value: T) => string;
    presets: readonly T[];
    /** Present for a continuous value: asks for any value in its own range (R43). */
    custom?: Readonly<{ title: string; body: string; invalid: string; defaultValue: string; parse: (raw: string) => T | null }>;
    editable: boolean;
    failed: string | null;
    awaiting?: string | null;
    onChange: (value: T) => void;
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
    const idOf = (value: T) => String(value);
    const choices = props.presets.map(value => ({ id: idOf(value), title: props.format(value) }));
    const { onChange, custom, presets } = props;
    const onCustom = React.useMemo(() => custom ? () => {
        fireAndForget((async () => {
            const raw = await Modal.prompt(custom.title, custom.body, { defaultValue: custom.defaultValue, confirmText: t('common.save') });
            if (raw === null) return;
            const value = custom.parse(raw);
            if (value === null) {
                Modal.alert(custom.title, custom.invalid);
                return;
            }
            onChange(value);
        })(), { tag: 'GuardSelectRow.custom' });
    } : undefined, [custom, onChange]);
    const current = idOf(props.value);
    return (
        // A select follows the shared row rule: beside its label on a wide row, beneath it on a phone.
        <Item testID={props.testID} title={props.title} subtitle={props.failed ?? props.awaiting ?? props.subtitle} mode="info" showDivider={props.showDivider}
            accessoryLayout="adaptive"
            subtitleStyle={props.failed ? { color: theme.colors.state.danger.textForeground } : undefined}
            rightElement={props.editable || props.failed ? (
                <PolicyValueSelect testID={`${props.testID}-select`} label={props.label} value={props.format(props.value)} choices={choices}
                    selectedId={choices.some(choice => choice.id === current) ? current : null}
                    onSelect={id => { const chosen = presets.find(value => idOf(value) === id); if (chosen !== undefined) onChange(chosen); }}
                    onCustom={onCustom} disabled={!props.editable} invalid={props.failed !== null} />
            ) : <ReadOnlyValue text={props.format(props.value)} />} />
    );
}

export function GuardChoiceRow<T extends string>(props: Readonly<{
    testID: string;
    title: string;
    /** Omitted: the chosen option's description says it. */
    subtitle?: string;
    options: ReadonlyArray<SegmentedChoiceOption<T>>;
    value: T;
    editable: boolean;
    failed: string | null;
    awaiting?: string | null;
    onChange: (value: T) => void;
}>) {
    const { theme } = useUnistyles();
    const chosen = props.options.find(option => option.id === props.value);
    const note = props.failed ?? props.awaiting ?? null;
    if (!props.editable && !props.failed) {
        return (
            <Item testID={props.testID} title={props.title} subtitle={note ?? props.subtitle ?? chosen?.description} mode="info"
                rightElement={<ReadOnlyValue text={chosen?.label ?? ''} />} />
        );
    }
    // A note takes the place of the chosen option's own description, which the segmented row would otherwise show.
    const options = note ? props.options.map(({ description: _description, ...option }) => option) : props.options;
    return (
        <SegmentedChoiceItem testID={props.testID} testIDPrefix={props.testID} title={props.title} subtitle={note ?? props.subtitle}
            subtitleStyle={props.failed ? { color: theme.colors.state.danger.textForeground } : undefined}
            value={props.value} disabled={!props.editable} options={options} onChange={props.onChange} />
    );
}

const styles = StyleSheet.create((theme) => ({
    value: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    quiet: {
        color: theme.colors.text.tertiary,
    },
}));
