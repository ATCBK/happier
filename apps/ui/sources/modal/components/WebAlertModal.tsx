import React from 'react';
import { View, Pressable } from 'react-native';
import { BaseModal } from './BaseModal';
import { AlertModalConfig, ConfirmModalConfig } from '../types';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFrame } from './card/ModalCardFrame';


interface WebAlertModalProps {
    config: AlertModalConfig | ConfirmModalConfig;
    onClose: () => void;
    onConfirm?: (value: boolean) => void;
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
        // Stretch, not centre: a centred text item sizes to its longest word, so an unbroken token
        // (a path, an id) would overflow the card. The text itself stays centred.
        alignItems: 'stretch',
    },
    title: {
        textAlign: 'center',
        color: theme.colors.text.primary,
        marginBottom: theme.space.s4,
    },
    message: {
        textAlign: 'center',
        color: theme.colors.text.primary,
        marginTop: theme.space.s4,
    },
    buttonContainer: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    buttonRow: {
        flexDirection: 'row',
    },
    buttonColumn: {
        flexDirection: 'column',
    },
    button: {
        flex: 1,
        paddingVertical: theme.space.s10,
        paddingHorizontal: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPressed: {
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
    buttonText: {
        color: theme.colors.text.primary,
        textAlign: 'center',
        flexShrink: 1,
        paddingHorizontal: theme.space.s2,
    },
    primaryText: {
        color: theme.colors.text.primary,
    },
    destructiveText: {
        color: theme.colors.state.danger.foreground,
    },
    irreversibleText: {
        color: theme.colors.state.warning.foreground,
    },
}));

export function WebAlertModal({ config, onClose, onConfirm, showBackdrop = true, visible = true, zIndexBase }: WebAlertModalProps) {
    useUnistyles();
    const styles = stylesheet;
    const isConfirm = config.type === 'confirm';
    
    const handleButtonPress = (buttonIndex: number) => {
        if (isConfirm && onConfirm) {
            onConfirm(buttonIndex === 1);
            return;
        }
        if (!isConfirm && config.buttons?.[buttonIndex]?.onPress) {
            config.buttons[buttonIndex].onPress!();
        }
        onClose();
    };

    // Escape and the hardware Back dismiss the card without a button press. An alert settles that through
    // its cancel choice, as the native alert does, so whoever awaits the decision (an unsaved-changes guard)
    // is released instead of waiting on a card that is gone. A confirm settles its dismissal in the provider.
    const handleDismiss = () => {
        if (!isConfirm) {
            config.buttons?.find((button) => button.style === 'cancel')?.onPress?.();
        }
        onClose();
    };

    const buttons = isConfirm
        ? [
            { text: config.cancelText || t('common.cancel'), style: 'cancel' as const },
            { text: config.confirmText || t('common.ok'), style: config.destructive ? 'destructive' as const : 'default' as const }
        ]
        : (config.buttons && config.buttons.length > 0)
            ? config.buttons
            : [{ text: t('common.ok'), style: 'default' as const }];

    // Two choices sit side by side; three or more stack, each a full-width row in the caller's order (DESIGN-9 N33).
    const buttonLayout = buttons.length > 2 ? 'column' : 'row';

    const resolveButtonTestId = (index: number): string => {
        if (isConfirm) {
            if (index === 0) return 'web-modal-cancel';
            if (index === 1) return 'web-modal-confirm';
        }
        return `web-modal-button-${index}`;
    };

    return (
        <BaseModal
            visible={visible}
            onClose={handleDismiss}
            accessibilityLabel={config.accessibilityLabel ?? config.title}
            closeOnBackdrop={false}
            showBackdrop={showBackdrop}
            zIndexBase={zIndexBase}
            focusReturnRef={config.focusReturnRef}
        >
            <ModalCardFrame dimensions={{ width: HAPPIER_PAGE_METRICS.dialogWidthPx.narrow, maxHeightRatio: 0.48 }}>
                <View style={styles.content}>
                    <Text variant="heading" style={styles.title}>
                        {config.title}
                    </Text>
                    {isConfirm && config.messageParagraphs ? config.messageParagraphs.map((paragraph, index) => (
                        <Text key={index} variant="body" emphasis={paragraph.irreversible ? 'semiBold' : undefined} style={[
                            styles.message,
                            paragraph.irreversible ? styles.irreversibleText : null,
                        ]}>
                            {paragraph.text}
                        </Text>
                    )) : config.message && (
                        <Text variant="body" style={styles.message}>
                            {config.message}
                        </Text>
                    )}
                </View>

                <View
                    style={[
                        styles.buttonContainer,
                        buttonLayout === 'row' ? styles.buttonRow : styles.buttonColumn,
                    ]}
                >
                    {buttons.map((button, index) => (
                        <React.Fragment key={index}>
                            {index > 0 && (
                                <View style={buttonLayout === 'row' ? styles.separatorVertical : styles.separatorHorizontal} />
                            )}
                            <Pressable
                                style={({ pressed }) => [
                                    styles.button,
                                    pressed && styles.buttonPressed
                                ]}
                                testID={resolveButtonTestId(index)}
                                accessibilityRole="button"
                                accessibilityLabel={button.text}
                                onPress={() => handleButtonPress(index)}
                            >
                                <Text variant="label" emphasis={button.style === 'cancel' ? 'regular' : 'semiBold'} style={[
                                    styles.buttonText,
                                    buttonLayout === 'column' && (button.style === 'default' || !button.style) && styles.primaryText,
                                    button.style === 'destructive' && styles.destructiveText,
                                ]}>
                                    {button.text}
                                </Text>
                            </Pressable>
                        </React.Fragment>
                    ))}
                </View>
            </ModalCardFrame>
        </BaseModal>
    );
}

export { ModalCardFrame } from './card/ModalCardFrame';
