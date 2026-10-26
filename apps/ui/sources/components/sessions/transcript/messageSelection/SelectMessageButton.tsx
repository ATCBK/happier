import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';

import type { TranscriptSelectableMessageRole } from './_types';
import { formatMessageSelectionRowAccessibilityLabel } from './messageSelectionAccessibility';
import { useOptionalTranscriptSelectionActions, useOptionalTranscriptSelectionRow } from './TranscriptMessageSelectionContext';
import { Icon } from '@/components/ui/icons/Icon';
import { useMessageActionHitArea } from '../messageActions/useMessageActionHitArea';

const TRANSCRIPT_SELECT_ACTION_ICON_SIZE = 12;
const TRANSCRIPT_SELECT_MODE_ICON_SIZE = 18;

export function SelectMessageButton(props: Readonly<{
    messageId: string;
    enabled: boolean;
    visible: boolean;
    role?: TranscriptSelectableMessageRole;
    previewText?: string;
    /** Whose message this is, where every message repeats the action (a Discussion thread): "…, Mei". */
    ownerLabel?: string;
    testID?: string;
    invertedActionsLayout?: boolean;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const actions = useOptionalTranscriptSelectionActions();
    const row = useOptionalTranscriptSelectionRow(props.messageId);
    const visible = props.visible || row.isSelectionMode;
    const hitArea = useMessageActionHitArea(props.invertedActionsLayout);

    if (!actions || !props.enabled || !visible) return null;

    const isSelectionToggle = row.isSelectionMode;
    const iconName = isSelectionToggle
        ? (row.isSelected ? 'check-square' : 'square')
        : 'check-circle';
    const iconColor = row.isSelected ? theme.colors.state.active.foreground : theme.colors.text.secondary;
    const accessibilityLabel = isSelectionToggle && props.role && props.previewText != null
        ? formatMessageSelectionRowAccessibilityLabel({ role: props.role, previewText: props.previewText })
        : props.ownerLabel ? `${t('transcript.selection.enterA11y')}, ${props.ownerLabel}` : t('transcript.selection.enterA11y');

    return (
        <Pressable
            testID={props.testID}
            onPress={isSelectionToggle ? row.toggle : () => actions.enter(props.messageId)}
            onHoverIn={props.onHoverIn}
            onHoverOut={props.onHoverOut}
            hitSlop={hitArea.hitSlop}
            onLayout={hitArea.onLayout}
            accessibilityRole={isSelectionToggle ? 'checkbox' : 'button'}
            accessibilityState={isSelectionToggle ? { checked: row.isSelected } : undefined}
            accessibilityLabel={accessibilityLabel}
            style={({ pressed }) => [
                styles.button,
                props.invertedActionsLayout ? styles.webActionButtonInverted : null,
                isSelectionToggle ? styles.selectionToggleButton : null,
                {
                    alignItems: 'center',
                    justifyContent: 'center',
                },
                row.isSelected ? styles.buttonSelected : null,
                pressed ? styles.buttonPressed : null,
            ]}
        >
            {hitArea.frame}
            <Icon
                name={iconName}
                size={isSelectionToggle ? TRANSCRIPT_SELECT_MODE_ICON_SIZE : TRANSCRIPT_SELECT_ACTION_ICON_SIZE}
                color={iconColor}
            />
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    button: {
        padding: theme.space.s6,
        borderRadius: 6,
        opacity: 0.6,
        cursor: 'pointer',
        marginRight: theme.space.s6,
    },
    webActionButtonInverted: {
        paddingHorizontal: theme.space.s4,
        marginRight: theme.space.s2,
    },
    selectionToggleButton: {
        padding: theme.space.s6,
        borderRadius: 16,
        backgroundColor: theme.colors.surface.base,
    },
    buttonSelected: {
        opacity: 1,
        backgroundColor: theme.colors.state.active.background,
    },
    buttonPressed: {
        opacity: 1,
        backgroundColor: theme.colors.state.neutral.background,
    },
}));
