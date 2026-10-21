import * as React from 'react';
import { readableMessageText } from '@/components/sessions/transcript/messageDisplayText';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { NewSessionLaunchAttempt } from '@/components/sessions/new/modules/newSessionLaunchAttempt';

/**
 * The compact `machine` presentation of the shared launch surface.
 *
 * Whether this card is the active presentation is decided once, by
 * `resolveNewSessionLaunchPresentation`; the authoring layouts only place it.
 * This component owns nothing but the rendering.
 */
export function NewSessionLaunchPendingPreview(props: Readonly<{
    launchAttempt: NewSessionLaunchAttempt | null | undefined;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    if (!props.launchAttempt) {
        return null;
    }

    const promptText = readableMessageText(props.launchAttempt.prompt.displayText.trim()
        || props.launchAttempt.prompt.prompt.trim());

    return (
        <View
            accessibilityLabel={t('newSession.startingSession')}
            accessibilityRole="progressbar"
            testID="new-session-launch-pending-preview"
            style={{
                width: '100%',
                alignSelf: 'center',
                borderWidth: 1,
                borderRadius: 8,
                borderColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.elevated,
                padding: theme.space.s12,
                gap: theme.space.s10,
            }}
        >
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.space.s8,
                }}
            >
                <ActivitySpinner
                    size="small"
                    color={theme.colors.text.secondary}
                    testID="new-session-launch-pending-preview-spinner"
                />
                <Text
                    testID="new-session-launch-pending-preview-status"
                    style={{
                        color: theme.colors.text.secondary,
                    }}
                >
                    {t('newSession.startingSession')}
                </Text>
            </View>
            <View
                style={{
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface.base,
                    paddingHorizontal: theme.space.s12,
                    paddingVertical: theme.space.s10,
                }}
            >
                <Text
                    numberOfLines={6}
                    testID="new-session-launch-pending-preview-prompt"
                    style={{
                        color: theme.colors.text.primary,
                    }}
                >
                    {promptText}
                </Text>
            </View>
        </View>
    );
}
