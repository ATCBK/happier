import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { useSessionTerminalAction } from '@/components/sessions/terminal/useSessionTerminalAction';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';
import { SESSION_HEADER_ICON_SIZE_PX, resolveSessionHeaderActionTargetPx } from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';

export const SessionHeaderTerminalButton = React.memo((_props: Readonly<{ sessionId: string; scopeId: string }>) => {
    const { theme } = useUnistyles();
    const { available, onPress } = useSessionTerminalAction(_props);
    const testId = useOptionalSessionScreenTestId('session-header-terminal-button');

    if (!available) return null;

    return (
        <Pressable
            testID={testId}
            onPress={onPress}
            hitSlop={15}
            style={({ pressed }) => ({
                width: resolveSessionHeaderActionTargetPx(),
                height: resolveSessionHeaderActionTargetPx(),
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? motionTokens.press.opacity : 1,
            })}
            accessibilityRole="button"
            accessibilityLabel={t('settings.terminal')}
        >
            <Icon name="terminal" size={SESSION_HEADER_ICON_SIZE_PX} color={theme.colors.chrome.header.foreground} />
        </Pressable>
    );
});
