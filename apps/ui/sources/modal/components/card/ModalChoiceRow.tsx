import * as React from 'react';
import { Platform, View } from 'react-native';
import { HappierPressable, happierFocusRingStyle } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';

export type ModalChoice = Readonly<{
    text: string;
    testID?: string;
    /** `cancel` reads quieter (regular weight); `destructive` takes the danger ink. */
    role?: 'default' | 'cancel' | 'destructive';
    onPress: () => void;
    /** A choice that must read input before the dialog's own dismissal can race it (a prompt's confirm). */
    onPressIn?: () => void;
}>;

/**
 * The alert idiom's choices: full-bleed text rows under a hairline, two side by side, three or more
 * stacked in the caller's order (DESIGN-9 N33). The one owner for the web alert and prompt cards.
 * Each choice is the shared pressable (focus ring, press lifecycle) at the device's target floor:
 * the platform touch floor under a finger, the dense row under a precise pointer.
 */
export function ModalChoiceRow(props: Readonly<{ choices: readonly ModalChoice[] }>) {
    const { theme } = useUnistyles();
    const column = props.choices.length > 2;
    const minHeight = resolveMinimumInteractiveTargetSize(Platform.OS);
    return (
        <View style={[styles.container, column ? styles.column : styles.row]}>
            {props.choices.map((choice, index) => (
                <React.Fragment key={index}>
                    {index > 0 ? <View style={column ? styles.separatorHorizontal : styles.separatorVertical} /> : null}
                    <HappierPressable
                        testID={choice.testID}
                        accessibilityLabel={choice.text}
                        onPressIn={choice.onPressIn}
                        onPress={choice.onPress}
                        style={({ pressed, focused }) => [
                            styles.choice,
                            { minHeight },
                            pressed ? styles.choicePressed : null,
                            happierFocusRingStyle({ visible: focused, color: theme.colors.border.focus, placement: 'inset' }),
                        ]}
                    >
                        <Text
                            variant="label"
                            emphasis={choice.role === 'cancel' ? 'regular' : 'semiBold'}
                            style={[styles.text, choice.role === 'destructive' ? styles.destructiveText : null]}
                        >
                            {choice.text}
                        </Text>
                    </HappierPressable>
                </React.Fragment>
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    row: {
        flexDirection: 'row',
    },
    column: {
        flexDirection: 'column',
    },
    choice: {
        flex: 1,
        paddingVertical: theme.space.s10,
        paddingHorizontal: theme.space.s12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    choicePressed: {
        backgroundColor: theme.colors.border.default,
    },
    separatorVertical: {
        width: 1,
        backgroundColor: theme.colors.border.default,
    },
    separatorHorizontal: {
        height: 1,
        backgroundColor: theme.colors.border.default,
    },
    text: {
        color: theme.colors.text.primary,
        textAlign: 'center',
        flexShrink: 1,
        paddingHorizontal: theme.space.s2,
    },
    destructiveText: {
        color: theme.colors.state.danger.foreground,
    },
}));
