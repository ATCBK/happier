import * as React from 'react';

import { SessionRightPanelTerminalView } from '@/components/sessions/panes/terminal/SessionRightPanelTerminalView';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

export const SessionTerminalSurface = React.memo((props: Readonly<{
    sessionId: string;
    scopeId: string;
}>) => {
    const presented = useLayoutPresentationActive();
    // Retain the scene/workspace, but release a hidden renderer's live PTY
    // attachment. The terminal owner recovers it by census on warm return.
    if (!presented) return null;
    return (
        <SessionRightPanelTerminalView
            sessionId={props.sessionId}
            scopeId={props.scopeId}
        />
    );
});
