import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
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
    return React.useCallback(() => {
        deferOnWeb(() => {
            // Retain review state; the composer's shared focus request reveals its main column.
            closeDetails();
            closeRight();
            cockpitNavigation?.switchSurface('chat');
            const session = parseSessionPaneScopeId(scopeId);
            if (!cockpitNavigation && session && pathname === `/session/${encodeURIComponent(session.sessionId)}/details`) {
                router.replace(resolveSessionRoutePathForSurface(session.sessionId, 'chat', { serverId: session.address?.serverId }));
            }
            requestAnimationFrame(() => { executeKeyboardCommand('composer.focus'); });
        });
    }, [closeDetails, closeRight, cockpitNavigation, executeKeyboardCommand, pathname, router, scopeId]);
}
