import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useOpenSessionComputerScreen } from '@/components/computer/useOpenSessionComputerScreen';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useOptionalSessionViewerController } from '@/components/sessions/viewer/SessionViewerController';
import { useSessionViewerMachineId } from '@/components/sessions/viewer/useSessionViewerMachine';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { SESSION_HEADER_ACTION_SIZE_PX } from './sessionHeaderIconMetrics';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';

/**
 * Desktop/web session-header entry to the Session's Computer, the sibling of the Browser button.
 * It asks the one canonical opener (`useOpenSessionComputerScreen`, the mounted viewer's
 * `viewer.open` for the computer source) rather than any pane route of its own, so the picture
 * floats beside the reading column exactly as it does from a transcript Watch. Like the Browser
 * button it stays in the header whenever the Session has a Machine, so the header never shifts with
 * the Machine's reachability: while the Machine cannot take the request the viewer opens on this
 * client and its own unavailable state says so. There is no button where no viewer owner is mounted
 * or the Session has no Machine. On a phone the viewer docks at the top of the reading flow and
 * opens from the transcript and the presence strip, so the header carries nothing there.
 */
export const SessionHeaderComputerButton = React.memo((props: Readonly<{
    sessionId: string;
    serverId: string | null;
}>) => {
    const { theme } = useUnistyles();
    const deviceType = useDeviceType();
    const serverId = usePreferredServerIdForSession({ sessionId: props.sessionId, serverId: props.serverId });
    const open = useOpenSessionComputerScreen({ sessionId: props.sessionId, serverId: props.serverId });
    const viewer = useOptionalSessionViewerController();
    const hasMachine = useSessionViewerMachineId(props.sessionId, serverId) !== null;
    const port = viewer?.port;
    // The Action front door reaches the Session's Machine; one that cannot be reached still has a viewer to say so.
    const openHere = React.useCallback(() => {
        port?.apply({ kind: 'viewer.open', source: 'computer' });
    }, [port]);
    const testId = useOptionalSessionScreenTestId('session-header-computer-button');

    if (deviceType === 'phone' || !port || !hasMachine) return null;

    const label = t('computerUse.presentation.sourceComputer');
    return (
        <IconButton
            testID={testId ?? 'session-header-computer-button'}
            variant="plain"
            size={SESSION_HEADER_ACTION_SIZE_PX}
            minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
            accessibilityLabel={label}
            tooltip={label}
            onPress={open ?? openHere}
            icon={<Icon name="desktop" size={ICON_SIZE.sm} color={theme.colors.chrome.header.foreground} />}
        />
    );
});

SessionHeaderComputerButton.displayName = 'SessionHeaderComputerButton';
