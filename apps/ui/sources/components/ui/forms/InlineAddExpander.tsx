import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { StyleProp, ViewStyle } from 'react-native';

import { ItemAddRow } from '@/components/ui/lists/ItemAddRow';
import { Typography } from '@/constants/Typography';
import { Text, TextInput } from '@/components/ui/text/Text';
import { SplitActionButtons } from '@/components/ui/forms/SplitActionButtons';


export interface InlineAddExpanderProps {
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    triggerTestID?: string;

    title: string;
    /** A section can host the trigger itself; null leaves just the inline form. */
    trigger?: React.ReactNode;
    subtitle?: string;

    helpText?: string;
    children: React.ReactNode;

    onCancel: () => void;
    onSave: () => void;
    saveDisabled?: boolean;

    cancelLabel: string;
    saveLabel: string;
    cancelTestID?: string;
    saveTestID?: string;

    autoFocusRef?: React.RefObject<React.ElementRef<typeof TextInput> | null>;
    expandedContainerStyle?: StyleProp<ViewStyle>;
}

export function InlineAddExpander({
    isOpen,
    onOpenChange,
    triggerTestID,
    title,
    trigger,
    subtitle,
    helpText,
    children,
    onCancel,
    onSave,
    saveDisabled = false,
    cancelLabel,
    saveLabel,
    cancelTestID,
    saveTestID,
    autoFocusRef,
    expandedContainerStyle,
}: InlineAddExpanderProps) {
    const styles = stylesheet;

    React.useEffect(() => {
        if (!isOpen) return;
        if (!autoFocusRef?.current) return;
        const id = setTimeout(() => autoFocusRef.current?.focus(), 30);
        return () => clearTimeout(id);
    }, [autoFocusRef, isOpen]);

    return (
        <>
            {trigger !== undefined ? trigger : <ItemAddRow
                testID={triggerTestID}
                title={title}
                subtitle={subtitle}
                expanded={isOpen}
                onPress={() => onOpenChange(!isOpen)}
                showDivider={Boolean(isOpen)}
            />}

            {isOpen ? (
                <View style={[styles.expandedContainer, expandedContainerStyle]}>
                    {helpText ? (
                        <Text accessibilityLiveRegion="polite" style={styles.helpText}>
                            {helpText}
                        </Text>
                    ) : null}

                    {children}

                    <View style={{ height: 16 }} />

                    <SplitActionButtons
                        secondaryLabel={cancelLabel}
                        onSecondaryPress={onCancel}
                        primaryLabel={saveLabel}
                        onPrimaryPress={onSave}
                        primaryDisabled={saveDisabled}
                        secondaryTestID={cancelTestID}
                        primaryTestID={saveTestID}
                    />
                </View>
            ) : null}
        </>
    );
}


const stylesheet = StyleSheet.create((theme) => ({
    expandedContainer: {
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s16,
    },
    helpText: {
        color: theme.colors.text.secondary,
        marginBottom: theme.space.s12,
        ...Typography.variant('body'),
    },
}));
