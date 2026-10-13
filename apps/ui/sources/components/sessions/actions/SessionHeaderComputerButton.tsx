import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useOpenSessionComputerScreen } from '@/components/computer/useOpenSessionComputerScreen';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { SESSION_HEADER_ACTION_SIZE_PX } from './sessionHeaderIconMetrics';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';

/**
 * Desktop/web session-header entry to the Session's Computer, the sibling of the Browser button.
 * It asks the one canonical opener (`useOpenSessionComputerScreen`, the mounted viewer's
 * `viewer.open` for the computer source) rather than any pane route of its own, so the picture
 * floats beside the reading column exactly as it does from a transcript Watch. The opener is null
 * where no viewer owner is mounted or the Session has no machine to watch, and then there is no
 * button. On a phone the viewer docks at the top of the reading flow and opens from the transcript
 * and the presence strip, so the header carries nothing there.
 */
export const SessionHeaderComputerButton = React.memo((props: Readonly<{
    sessionId: string;
    serverId: string | null;
}>) => {
    const { theme } = useUnistyles();
    const deviceType = useDeviceType();
    const open = useOpenSessionComputerScreen({ sessionId: props.sessionId, serverId: props.serverId });
    const testId = useOptionalSessionScreenTestId('session-header-computer-button');

    if (deviceType === 'phone' || !open) return null;

    const label = t('computerUse.viewer.sourceComputer');
    return (
        <IconButton
            testID={testId ?? 'session-header-computer-button'}
            variant="plain"
            size={SESSION_HEADER_ACTION_SIZE_PX}
            minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
            accessibilityLabel={label}
            tooltip={label}
            onPress={open}
            icon={<Icon name="desktop" size={ICON_SIZE.sm} color={theme.colors.chrome.header.foreground} />}
        />
    );
});

SessionHeaderComputerButton.displayName = 'SessionHeaderComputerButton';
