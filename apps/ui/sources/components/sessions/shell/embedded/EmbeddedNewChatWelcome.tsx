import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_STATE_SIZE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    welcome: {
        ...Typography.default('semiBold'),
        // The inviting state's title in a chat-sized container (lab 04 "New chat": 17 / 22).
        ...HAPPIER_STATE_SIZE_METRICS.details.title,
        textAlign: 'center',
        paddingHorizontal: theme.space.s20,
        color: theme.colors.text.primary,
    },
}));

/**
 * The quiet line an embedded new chat shows above its composer before anything has been said
 * (plan 04 §6.1). The embed's new chat and the Settings preview render this one element.
 */
export function EmbeddedNewChatWelcome(): React.ReactElement {
    return (
        <Text testID="embedded-new-chat-welcome" accessibilityRole="header" style={stylesheet.welcome}>
            {t('session.embedded.newChatWelcome')}
        </Text>
    );
}
