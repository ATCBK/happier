import React, { useState, useRef, useEffect } from 'react';
import { View, KeyboardTypeOptions, Platform } from 'react-native';
import { BaseModal } from './BaseModal';
import { PromptModalConfig } from '../types';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text, TextInput } from '@/components/ui/text/Text';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { t } from '@/text';
import { ModalCardFrame } from './card/ModalCardFrame';
import { ModalChoiceRow } from './card/ModalChoiceRow';


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
    // The shared page field box spans the card under the title.
    field: {
        alignSelf: 'stretch',
        marginTop: theme.space.s16,
    },
}));

export function WebPromptModal({ config, onClose, onConfirm, showBackdrop = true, visible = true, zIndexBase }: WebPromptModalProps) {
    useUnistyles();
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
                    {config.message ? (
                        <Text variant="body" style={styles.message}>
                            {config.message}
                        </Text>
                    ) : null}
                    <FieldTextInput
                        ref={inputRef}
                        testID="web-prompt-input"
                        style={styles.field}
                        accessibilityLabel={config.title}
                        value={inputValue}
                        onChangeText={setInputValue}
                        placeholder={config.placeholder}
                        keyboardType={getKeyboardType()}
                        secureTextEntry={config.inputType === 'secure-text'}
                        autoCapitalize="none"
                        autoFocus={Platform.OS === 'web'}
                        onSubmitEditing={handleConfirm}
                        returnKeyType="done"
                    />
                </View>
                
                <ModalChoiceRow choices={[
                    { text: config.cancelText || t('common.cancel'), testID: 'web-prompt-cancel', role: 'cancel', onPress: handleCancel },
                    // Confirm on press-in too: the typed value is read before a blur or close can race it.
                    { text: config.confirmText || t('common.ok'), testID: 'web-prompt-confirm', onPressIn: handleConfirm, onPress: handleConfirm },
                ]} />
            </ModalCardFrame>
        </BaseModal>
    );
}
