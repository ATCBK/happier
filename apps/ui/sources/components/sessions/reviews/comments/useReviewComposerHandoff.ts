import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useSessionCockpitSurfaceNavigation } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { useKeyboardCommand } from '@/keyboard/KeyboardShortcutProvider';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';

export function useReviewComposerHandoff(scopeId: string): () => void {
    const { closeDetails, closeRight } = useAppPaneScope(scopeId);
    const executeKeyboardCommand = useKeyboardCommand();
    const cockpitNavigation = useSessionCockpitSurfaceNavigation();
    return React.useCallback(() => {
        deferOnWeb(() => {
            // Retain review state; the composer's shared focus request reveals its main column.
            closeDetails();
            closeRight();
            cockpitNavigation?.switchSurface('chat');
            requestAnimationFrame(() => { executeKeyboardCommand('composer.focus'); });
        });
    }, [closeDetails, closeRight, cockpitNavigation, executeKeyboardCommand]);
}
