import React, { useState, useRef, useEffect } from 'react';
import { View, Pressable, KeyboardTypeOptions, Platform } from 'react-native';
import { BaseModal } from './BaseModal';
import { PromptModalConfig } from '../types';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { ModalCardFrame } from './card/ModalCardFrame';


interface WebPromptModalProps {
    config: PromptModalConfig;
    onClose: () => void;
    onConfirm: (value: string | null) => void;
    showBackdrop?: boolean;
    /** False while the dialog leaves; the host unmounts it once the exit has played. */
    visible?: boolean;
    zIndexBase?: number;
}

const stylesheet = StyleSheet.create((theme) => ({
    content: {
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s20,
        paddingBottom: theme.space.s16,
        alignItems: 'center'
    },
    title: {
        textAlign: 'center',
        color: theme.colors.text.primary,
        marginBottom: theme.space.s4
    },
    message: {
        textAlign: 'center',
        color: theme.colors.text.primary,
        marginTop: theme.space.s4
    },
    input: {
        width: '100%',
        height: 36,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 8,
        paddingHorizontal: theme.space.s10,
        marginTop: theme.space.s16,
        color: theme.colors.text.primary,
        backgroundColor: theme.colors.input.background
    },
    buttonContainer: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        flexDirection: 'row'
    },
    button: {
        flex: 1,
        paddingVertical: theme.space.s10,
        alignItems: 'center',
        justifyContent: 'center'
    },
    buttonPressed: {
        backgroundColor: theme.colors.border.default
    },
    buttonSeparator: {
        width: 1,
        backgroundColor: theme.colors.border.default
    },
    buttonText: {
        color: theme.colors.text.primary
    }
}));

export function WebPromptModal({ config, onClose, onConfirm, showBackdrop = true, visible = true, zIndexBase }: WebPromptModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [inputValue, setInputValue] = useState(config.defaultValue || '');
    const inputRef = useRef<React.ElementRef<typeof TextInput> | null>(null);
    const didResolveRef = useRef(false);

    const resolveAndClose = React.useCallback((value: string | null) => {
        if (didResolveRef.current) {
            return;
        }

        didResolveRef.current = true;
        onConfirm(value);
        onClose();
    }, [onClose, onConfirm]);

    useEffect(() => {
        // Auto-focus the input when modal opens
        const timer = setTimeout(() => {
            inputRef.current?.focus();
        }, 100);
        return () => clearTimeout(timer);
    }, []);

    const handleCancel = () => {
        resolveAndClose(null);
    };

    const handleConfirm = () => {
        resolveAndClose(inputValue);
    };

    const getKeyboardType = (): KeyboardTypeOptions => {
        switch (config.inputType) {
            case 'email-address':
                return 'email-address';
            case 'numeric':
                return 'numeric';
            default:
                return 'default';
        }
    };

    return (
        <BaseModal
            visible={visible}
            onClose={handleCancel}
            accessibilityLabel={config.accessibilityLabel ?? config.title}
            focusReturnRef={config.focusReturnRef}
            closeOnBackdrop={false}
            showBackdrop={showBackdrop}
            zIndexBase={zIndexBase}
        >
            <ModalCardFrame dimensions={{ width: HAPPIER_PAGE_METRICS.dialogWidthPx.narrow, maxHeightRatio: 0.48 }}>
                <View style={styles.content}>
                    <Text variant="heading" style={styles.title}>
                        {config.title}
                    </Text>
                    {config.message && (
                        <Text variant="body" style={styles.message}>
                            {config.message}
                        </Text>
                    )}
                    <TextInput
                        ref={inputRef}
                        testID="web-prompt-input"
                        variant="label" emphasis="regular" style={styles.input}
                        value={inputValue}
                        onChangeText={setInputValue}
                        placeholder={config.placeholder}
                        placeholderTextColor={theme.colors.input.placeholder}
                        keyboardType={getKeyboardType()}
                        secureTextEntry={config.inputType === 'secure-text'}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoFocus={Platform.OS === 'web'}
                        onSubmitEditing={handleConfirm}
                        returnKeyType="done"
                    />
                </View>
                
                <View style={styles.buttonContainer}>
                    <Pressable
                        style={({ pressed }) => [
                            styles.button,
                            pressed && styles.buttonPressed
                        ]}
                        testID="web-prompt-cancel"
                        accessibilityRole="button"
                        accessibilityLabel={config.cancelText || t('common.cancel')}
                        onPress={handleCancel}
                    >
                        <Text variant="label" emphasis="regular" style={styles.buttonText}>
                            {config.cancelText || t('common.cancel')}
                        </Text>
                    </Pressable>
                    <View style={styles.buttonSeparator} />
                    <Pressable
                        style={({ pressed }) => [
                            styles.button,
                            pressed && styles.buttonPressed
                        ]}
                        testID="web-prompt-confirm"
                        accessibilityRole="button"
                        accessibilityLabel={config.confirmText || t('common.ok')}
                        onPressIn={handleConfirm}
                        onPress={handleConfirm}
                    >
                        <Text variant="label" emphasis="semiBold" style={styles.buttonText}>
                            {config.confirmText || t('common.ok')}
                        </Text>
                    </Pressable>
                </View>
            </ModalCardFrame>
        </BaseModal>
    );
}
