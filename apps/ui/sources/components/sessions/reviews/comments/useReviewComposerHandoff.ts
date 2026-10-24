import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { useDestinationPathname, useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useSessionCockpitSurfaceNavigation } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useKeyboardCommand } from '@/keyboard/KeyboardShortcutProvider';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';

export function useReviewComposerHandoff(scopeId: string): () => void {
    const { closeDetails, closeRight } = useAppPaneScope(scopeId);
    const executeKeyboardCommand = useKeyboardCommand();
    const cockpitNavigation = useSessionCockpitSurfaceNavigation();
    const pathname = useDestinationPathname();
    const router = useDestinationRouter();
    // Read at call time: the handoff decides from the layout the person sees when they ask.
    const layout = useOptionalAppPaneScopeLayout();
    const layoutRef = React.useRef(layout);
    layoutRef.current = layout;
    return React.useCallback(() => {
        deferOnWeb(() => {
            const session = parseSessionPaneScopeId(scopeId);
            const fullPageReading = !cockpitNavigation && session !== null
                && pathname === `/session/${encodeURIComponent(session.sessionId)}/details`;
            // A reading docked beside the visible Session stays where it is; only what covers the Session
            // closes. A full-page reading always gives way to the Session. Review state is retained either
            // way, and the composer's shared focus request reveals its main column.
            const current = layoutRef.current;
            const readingDockedBesideSession = !fullPageReading && current != null && current.effectiveDetailsOpen
                && !current.mainHidden && current.layout.main === 'docked' && current.layout.details === 'docked';
            if (!readingDockedBesideSession) closeDetails();
            if (!readingDockedBesideSession || current?.layout.right === 'overlay') closeRight();
            cockpitNavigation?.switchSurface('chat');
            if (fullPageReading && session) {
                router.replace(resolveSessionRoutePathForSurface(session.sessionId, 'chat', { serverId: session.address?.serverId }));
            }
            requestAnimationFrame(() => { executeKeyboardCommand('composer.focus'); });
        });
    }, [closeDetails, closeRight, cockpitNavigation, executeKeyboardCommand, pathname, router, scopeId]);
}
