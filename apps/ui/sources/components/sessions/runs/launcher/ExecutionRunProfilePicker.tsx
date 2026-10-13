import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

import type { ExecutionRunLauncherProfileChoice } from './resolveExecutionRunLauncherProfileChoices';
import { motionTokens } from '@/components/ui/motion/motionTokens';

export const ExecutionRunProfilePicker = React.memo((props: Readonly<{
    choices: readonly ExecutionRunLauncherProfileChoice[];
    selectedId: string;
    editable?: boolean;
    sectionLabel: string;
    resolveAccessibilityLabel: (title: string) => string;
    onSelect: (choice: ExecutionRunLauncherProfileChoice) => void;
}>) => {
    const { theme } = useUnistyles();
    const interactiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    if (props.choices.length === 0) return null;

    return (
        <View style={{ gap: theme.space.s8 }}>
            <Text accessibilityRole="header" style={{  color: theme.colors.text.primary, ...Typography.variant('label', 'semiBold') }}>
                {props.sectionLabel}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s10 }}>
                {props.choices.map((choice) => {
                    const selected = choice.id === props.selectedId;
                    return (
                        <Pressable
                            key={choice.id}
                            testID={`execution-run-launcher-profile:${choice.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={props.resolveAccessibilityLabel(choice.title)}
                            accessibilityState={{ selected, disabled: choice.disabled || props.editable === false }}
                            disabled={choice.disabled || props.editable === false}
                            onPress={() => props.onSelect(choice)}
                            style={({ pressed }) => ({
                                minWidth: interactiveTargetSize,
                                minHeight: interactiveTargetSize,
                                alignItems: 'center',
                                justifyContent: 'center',
                                paddingVertical: theme.space.s8,
                                paddingHorizontal: theme.space.s10,
                                borderRadius: 10,
                                borderWidth: 1,
                                borderColor: theme.colors.border.default,
                                backgroundColor: theme.colors.surface.inset,
                                opacity: choice.disabled || props.editable === false ? 0.45 : pressed ? motionTokens.press.opacity : 1,
                            })}
                        >
                            <Text style={{
                                color: selected ? theme.colors.text.primary : theme.colors.text.secondary,
                                ...Typography.variant('meta', 'semiBold'),
                            }}>
                                {choice.title}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
});
