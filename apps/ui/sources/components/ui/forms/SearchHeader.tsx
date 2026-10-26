import * as React from 'react';
import { View, Platform, Pressable, StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';
import { TextInput } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { HappierPressable, useHappierHitArea, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';


export interface SearchHeaderProps {
    testID?: string;
    value: string;
    onChangeText: (text: string) => void;
    placeholder: string;
    containerStyle?: StyleProp<ViewStyle>;
    autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
    autoCorrect?: boolean;
    inputRef?: React.Ref<React.ElementRef<typeof TextInput>>;
    onFocus?: () => void;
    onBlur?: () => void;
}

const INPUT_BORDER_RADIUS = 10;
const SEARCH_HEADER_PADDING_BOTTOM = 12;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface.base,
        paddingTop: 0,
        paddingBottom: SEARCH_HEADER_PADDING_BOTTOM,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    content: {
        width: '100%',
        paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(),
        alignSelf: 'center',
    },
    inputWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.input.background,
        borderRadius: INPUT_BORDER_RADIUS,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s8,
    },
    textInput: {
        flex: 1,
        ...Typography.default('regular'),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
        paddingVertical: 0,
    },
    clearIcon: {
        marginLeft: theme.space.s8,
    },
}));

export function SearchHeader({
    testID,
    value,
    onChangeText,
    placeholder,
    containerStyle,
    autoCapitalize = 'none',
    autoCorrect = false,
    inputRef,
    onFocus,
    onBlur,
}: SearchHeaderProps) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const maxWidth = useLayoutMaxWidth();
    const styles = stylesheet;
    // The field draws at its padding and line height (about 38 on iOS, 40 elsewhere). Under a finger
    // the shared hit area reaches the touch target past it, and a tap anywhere in it focuses the input.
    const input = React.useRef<React.ElementRef<typeof TextInput> | null>(null);
    const setInput = React.useCallback((node: React.ElementRef<typeof TextInput> | null) => {
        input.current = node;
        if (typeof inputRef === 'function') inputRef(node);
        else if (inputRef) (inputRef as React.MutableRefObject<React.ElementRef<typeof TextInput> | null>).current = node;
    }, [inputRef]);
    const focusInput = React.useCallback(() => input.current?.focus?.(), []);
    const wrapperHitArea = useHappierHitArea({ restingStyle: () => styles.inputWrapper });

    return (
        <View testID={testID} style={[styles.container, { backgroundColor: paintColor(theme.colors.surface.base, 'transparent') }, containerStyle]}>
            <View style={[styles.content, { maxWidth }]}>
                <Pressable
                    onPress={focusInput}
                    accessible={false}
                    focusable={false}
                    tabIndex={-1}
                    hitSlop={wrapperHitArea.hitSlop}
                    onLayout={wrapperHitArea.onLayout}
                    style={[styles.inputWrapper, { backgroundColor: paintColor(theme.colors.input.background) }]}
                >
                    {wrapperHitArea.frame}
                    {normalizeNodeForView(
                        <Icon
                            name="magnifying-glass"
                            size={20}
                            color={theme.colors.text.secondary}
                            style={{ marginRight: theme.space.s8 }}
                        />,
                    )}
                    <TextInput
                        testID={testID ? `${testID}:input` : undefined}
                        ref={setInput}
                        value={value}
                        onChangeText={onChangeText}
                        placeholder={placeholder}
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize={autoCapitalize}
                        autoCorrect={autoCorrect}
                        onFocus={onFocus}
                        onBlur={onBlur}
                        style={styles.textInput}
                    />
                    {value.length > 0 && (
                        <HappierPressable
                            onPress={() => onChangeText('')}
                            hitTarget={24}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.clearSearch')}
                        >
                            {normalizeNodeForView(
                                <Icon
                                    name="x-circle"
                                    size={20}
                                    color={theme.colors.text.secondary}
                                    style={styles.clearIcon}
                                />,
                            )}
                        </HappierPressable>
                    )}
                </Pressable>
            </View>
        </View>
    );
}
