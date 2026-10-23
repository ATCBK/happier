import * as React from 'react';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';

export type RightPanelPlacement = 'canvas' | 'sheet';

/**
 * The person's choice of where the docked right panel stands (calm-shell R4-2): `canvas` beside the
 * page on the navigation plane (the default), or `sheet` inside the page. Read and written by the
 * Appearance row and the Look panel; the shell frame alone resolves what it means for a window.
 */
export function useRightPanelPlacement() {
    const value = useLocalSetting('rightPanelPlacement');
    const applyLocalSettings = useApplyLocalSettings();
    const placement: RightPanelPlacement = value === 'sheet' ? 'sheet' : 'canvas';
    const setPlacement = React.useCallback((next: RightPanelPlacement) => {
        applyLocalSettings({ rightPanelPlacement: next });
    }, [applyLocalSettings]);
    return React.useMemo(() => ({ placement, setPlacement }), [placement, setPlacement]);
}
