import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { HorizontalScrollableRow } from '@/components/ui/scroll/HorizontalScrollableRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import { t } from '@/text';

import { TERMINAL_RAIL_KEYS, type TerminalKeyModifiers, type TerminalRailKey } from './terminalKeyInput';

function railKeyLabel(key: TerminalRailKey): string {
    switch (key.id) {
        case 'esc': return t('terminalWorkspace.keys.esc');
        case 'tab': return t('terminalWorkspace.keys.tab');
        case 'ctrl': return t('terminalWorkspace.keys.ctrl');
        case 'alt': return t('terminalWorkspace.keys.alt');
        case 'ctrlC': return t('terminalWorkspace.keys.ctrlC');
        case 'ctrlD': return t('terminalWorkspace.keys.ctrlD');
        case 'hideKeyboard': return t('terminalWorkspace.keys.hideKeyboard');
        default: return key.kind === 'send' ? key.data : key.id;
    }
}

/**
 * The phone terminal's key rail (terminal lab P1): the keys a phone keyboard lacks, the full width
 * of the keyboard, scrolling sideways with a fade at the trailing edge. Keyboard-dismiss leads; Ctrl
 * and ⌥ latch for the next key and show it.
 */
export const TerminalKeyRail = React.memo(function TerminalKeyRail(props: Readonly<{
    modifiers: TerminalKeyModifiers;
    onPressKey: (key: TerminalRailKey) => void;
    testIdPrefix?: string | null;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.rail} accessibilityRole="toolbar" accessibilityLabel={t('terminalWorkspace.keys.railA11y')}>
            <HorizontalScrollableRow
                testID={props.testIdPrefix ? `${props.testIdPrefix}-key-rail` : undefined}
                fadeColor={theme.colors.surface.inset}
                indicatorColor={theme.colors.text.tertiary}
                contentStyle={styles.content}
            >
                {TERMINAL_RAIL_KEYS.map((key) => {
                    const latched = key.kind === 'modifier' && props.modifiers[key.id];
                    const label = railKeyLabel(key);
                    return (
                        <Pressable
                            key={key.id}
                            testID={props.testIdPrefix ? `${props.testIdPrefix}-key-${key.id}` : undefined}
                            accessibilityRole="button"
                            accessibilityLabel={label}
                            accessibilityState={key.kind === 'modifier' ? { selected: latched } : undefined}
                            onPress={() => props.onPressKey(key)}
                            style={({ pressed }) => [styles.key, latched ? styles.keyLatched : null, pressed && !latched ? styles.keyPressed : null]}
                        >
                            {key.kind === 'hideKeyboard'
                                ? <Icon name="keyboard" size={ICON_SIZE.sm} color={theme.colors.text.primary} />
                                : (
                                    <Text
                                        style={[styles.label, key.kind === 'send' && key.mono ? styles.labelMono : null, latched ? styles.labelLatched : null]}
                                        numberOfLines={1}
                                    >
                                        {label}
                                    </Text>
                                )}
                        </Pressable>
                    );
                })}
            </HorizontalScrollableRow>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    rail: {
        height: 46,
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.inset,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    content: {
        alignItems: 'center',
        gap: theme.space.s6,
        paddingLeft: theme.space.s8,
        paddingRight: theme.space.s24,
    },
    key: {
        minWidth: 44,
        height: 34,
        paddingHorizontal: theme.space.s10,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    keyPressed: {
        backgroundColor: theme.colors.surface.elevated,
    },
    keyLatched: {
        backgroundColor: theme.colors.text.primary,
        borderColor: theme.colors.text.primary,
    },
    label: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    labelMono: {
        ...Typography.mono(),
    },
    labelLatched: {
        color: theme.colors.surface.base,
    },
}));
