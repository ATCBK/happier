import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';

let nextItemKey = 0;
function createItemKey(): string {
    nextItemKey += 1;
    return `item-${nextItemKey}`;
}

/**
 * An ordered list of short strings (command arguments, tokens) edited as one field per value, with
 * remove beside each and "add" below. Place it as a stacked row control (`accessoryLayout="stacked"`).
 * Return in the last field adds the next one, so a list can be typed without the pointer.
 */
export const StringListField = React.memo(function StringListField(props: Readonly<{
    values: readonly string[];
    onChange: (values: string[]) => void;
    /** Names each field for assistive technology, by position (1-based). */
    itemLabel: (position: number) => string;
    removeLabel: (position: number) => string;
    addLabel: string;
    itemPlaceholder?: string;
    monospace?: boolean;
    /** A value was committed: a field lost focus or an entry was removed (lists that save in place). */
    onCommit?: () => void;
    /** Why one entry is refused, said under its own field (`<testID>.item.<i>.error`). */
    itemError?: (index: number) => string | null;
    disabled?: boolean;
    /** Test id prefix: `<testID>.item.<i>`, `<testID>.remove.<i>`, `<testID>.add`. */
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { values, onChange } = props;
    // Stable keys per value so removing one keeps the others' focus and cursor.
    const keysRef = React.useRef<string[]>([]);
    if (keysRef.current.length !== values.length) {
        keysRef.current = values.map((_, index) => keysRef.current[index] ?? createItemKey());
    }
    const [focusKey, setFocusKey] = React.useState<string | null>(null);

    const add = React.useCallback(() => {
        const key = createItemKey();
        keysRef.current = [...keysRef.current, key];
        setFocusKey(key);
        onChange([...values, '']);
    }, [onChange, values]);
    const remove = (index: number) => {
        keysRef.current = keysRef.current.filter((_, position) => position !== index);
        onChange(values.filter((_, position) => position !== index));
        props.onCommit?.();
    };
    const update = (index: number, text: string) => {
        onChange(values.map((value, position) => (position === index ? text : value)));
    };

    return (
        <View style={styles.list}>
            {values.map((value, index) => {
                const key = keysRef.current[index]!;
                const last = index === values.length - 1;
                return (
                    <View key={key} style={styles.item}>
                        <FieldTextInput
                            testID={`${props.testID}.item.${index}`}
                            value={value}
                            onChangeText={(text) => update(index, text)}
                            onBlur={props.onCommit}
                            error={props.itemError?.(index) ?? null}
                            editable={props.disabled !== true}
                            accessibilityLabel={props.itemLabel(index + 1)}
                            placeholder={props.itemPlaceholder}
                            monospace={props.monospace}
                            autoFocus={focusKey === key}
                            returnKeyType={last ? 'next' : undefined}
                            onSubmitEditing={last && value.trim().length > 0 ? add : undefined}
                            style={styles.field}
                        />
                        <IconButton
                            testID={`${props.testID}.remove.${index}`}
                            iconName="x"
                            variant="plain"
                            accessibilityLabel={props.removeLabel(index + 1)}
                            tooltip={props.removeLabel(index + 1)}
                            disabled={props.disabled}
                            onPress={() => remove(index)}
                        />
                    </View>
                );
            })}
            <View style={styles.addRow}>
                <RoundButton
                    testID={`${props.testID}.add`}
                    size="small"
                    display="inverted"
                    title={props.addLabel}
                    leading={<Icon name="plus" size={14} color={theme.colors.text.secondary} />}
                    disabled={props.disabled}
                    onPress={add}
                />
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    list: {
        gap: 6,
    },
    item: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    field: {
        flex: 1,
        minWidth: 0,
    },
    addRow: {
        flexDirection: 'row',
    },
}));
