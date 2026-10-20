import * as React from 'react';
import { useOptionalPaneFocusReturnOwner } from '@/components/appShell/panes/AppPaneProvider';

/** The retained source returns from a pushed File page without changing its viewport. */
export function useWorkspaceFileOriginReturn(scopeId: string, focused: boolean): void {
    const owner = useOptionalPaneFocusReturnOwner();
    React.useLayoutEffect(() => {
        if (focused) owner?.takeDetailsTabReturn(scopeId, null, 'route')?.();
    }, [focused, owner, scopeId]);
}
