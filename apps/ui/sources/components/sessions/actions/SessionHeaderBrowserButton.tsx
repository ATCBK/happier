import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { BrowserSurfaceOpenButton } from '@/components/browser/surfaces/BrowserSurfaceOpenButton';
import { getRightSidebarBuiltinTab } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useDeviceType } from '@/utils/platform/responsive';
import { SESSION_HEADER_ACTION_SIZE_PX } from './sessionHeaderIconMetrics';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';

function decisionEnabled(decision: ReturnType<typeof useFeatureDecision>): boolean {
    return decision?.state === 'enabled';
}

/**
 * Desktop/web entry to the Session's retained Browser source. The header and viewer Dock select
 * the same catalog destination, preserving the selected browser target and existing Details work.
 * A phone reaches that source through its cockpit Browser surface.
 *
 * Gating mirrors {@link BrowserSurfaceOpenButton}: the `browser` and `browser.viewTargets`
 * client-represented feature decisions must both be enabled.
 */
export const SessionHeaderBrowserButton = React.memo((props: Readonly<{
    sessionId: string;
    scopeId: string;
}>) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const deviceType = useDeviceType();
    const browserDecision = useFeatureDecision('browser', { scopeKind: 'runtime' });
    const viewTargetsDecision = useFeatureDecision('browser.viewTargets', { scopeKind: 'runtime' });
    const testId = useOptionalSessionScreenTestId('session-header-browser-button');

    const onPress = React.useCallback(() => {
        pane.openRight({ tabId: getRightSidebarBuiltinTab('browser').id, present: false });
    }, [pane.openRight]);

    // Mobile already exposes the browser via the right-sidebar surface; only desktop/web needs this
    // header entry point. `phone` is the canonical "mobile presentation" device type.
    if (deviceType === 'phone') {
        return null;
    }
    if (!decisionEnabled(browserDecision) || !decisionEnabled(viewTargetsDecision)) {
        return null;
    }

    return (
        <BrowserSurfaceOpenButton
            onPress={onPress}
            testID={testId ?? 'session-header-browser-button'}
            size={SESSION_HEADER_ACTION_SIZE_PX}
            iconColor={theme.colors.chrome.header.foreground}
        />
    );
});

SessionHeaderBrowserButton.displayName = 'SessionHeaderBrowserButton';
