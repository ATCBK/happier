import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ItemListStatic } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';


export interface SecretAddModalResult {
    name: string;
    value: string;
}

export interface SecretAddModalProps {
    onClose: () => void;
    onSubmit: (result: SecretAddModalResult) => void;
    title?: string;
}

export function SecretAddModal(props: SecretAddModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const [name, setName] = React.useState('');
    const [value, setValue] = React.useState('');

    const submit = React.useCallback(() => {
        const trimmedName = name.trim();
        if (!trimmedName) return;
        if (value.length === 0) return;
        props.onSubmit({ name: trimmedName, value });
        props.onClose();
    }, [name, props, value]);

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>{props.title ?? t('secrets.addTitle')}</Text>
                <Pressable
                    onPress={props.onClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={({ pressed }) => ({ opacity: pressed ? motionTokens.press.opacity : 1 })}
                >
                    <Icon name="x" size={20} color={theme.colors.text.secondary} />
                </Pressable>
            </View>

            <View style={styles.body}>
                <Text style={styles.helpText}>
                    {t('settings.secretsSubtitle')}
                </Text>

                <ItemListStatic style={{ backgroundColor: 'transparent' }}>
                    <ItemGroup title={t('secrets.addTitle')} containerStyle={{ marginHorizontal: 0 }}>
                        <View style={styles.inputContainer}>
                            <Text style={styles.fieldLabel}>{t('secrets.fields.name')}</Text>
                            <TextInput
                                style={styles.textInput}
                                placeholder={t('secrets.placeholders.nameExample')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={name}
                                onChangeText={setName}
                                autoCapitalize="none"
                                autoCorrect={false}
                            />

                            <View style={{ height: 12 }} />

                            <Text style={styles.fieldLabel}>{t('secrets.fields.value')}</Text>
                            <TextInput
                                style={styles.textInput}
                                placeholder={t('secrets.placeholders.valueExample')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={value}
                                onChangeText={setValue}
                                autoCapitalize="none"
                                autoCorrect={false}
                                secureTextEntry
                                textContentType={Platform.OS === 'ios' ? 'password' : undefined}
                            />
                        </View>
                    </ItemGroup>
                </ItemListStatic>

                <View style={{ height: 16 }} />

                <View style={{ flexDirection: 'row', gap: theme.space.s12 }}>
                    <View style={{ flex: 1 }}>
                        <Pressable
                            onPress={props.onClose}
                            style={({ pressed }) => ({
                                backgroundColor: theme.colors.surface.base,
                                borderRadius: 10,
                                paddingVertical: theme.space.s12,
                                alignItems: 'center',
                                opacity: pressed ? motionTokens.press.opacitySubtle : 1,
                            })}
                        >
                            <Text style={{ color: theme.colors.text.primary, ...Typography.default('semiBold') }}>
                                {t('common.cancel')}
                            </Text>
                        </Pressable>
                    </View>
                    <View style={{ flex: 1 }}>
                        <Pressable
                            onPress={submit}
                            disabled={!name.trim() || value.length === 0}
                            style={({ pressed }) => ({
                                backgroundColor: theme.colors.button.primary.background,
                                borderRadius: 10,
                                paddingVertical: theme.space.s12,
                                alignItems: 'center',
                                opacity: (!name.trim() || value.length === 0) ? 0.5 : (pressed ? motionTokens.press.opacitySubtle : 1),
                            })}
                        >
                            <Text style={{ color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>
                                {t('common.save')}
                            </Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '92%',
        maxWidth: 560,
        backgroundColor: theme.colors.background.canvas,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        flexShrink: 1,
    },
    header: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    headerTitle: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    body: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
    },
    inputContainer: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
    },
    helpText: {
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
        marginBottom: theme.space.s12,
        ...Typography.default(),
    },
    fieldLabel: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
        marginBottom: theme.space.s8,
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: theme.space.s12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
    },
}));
