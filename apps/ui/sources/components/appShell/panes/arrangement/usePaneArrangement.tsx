import * as React from 'react';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import type { PaneArrangement } from '@/components/ui/panels/paneBreakpoints';

export function usePaneArrangement() {
    const value = useLocalSetting('paneArrangement');
    const applyLocalSettings = useApplyLocalSettings();
    const arrangement: PaneArrangement = value === 'editor' ? 'editor' : 'session';
    const setArrangement = React.useCallback((next: PaneArrangement) => {
        applyLocalSettings({ paneArrangement: next });
    }, [applyLocalSettings]);
    const toggle = React.useCallback(() => setArrangement(arrangement === 'editor' ? 'session' : 'editor'), [arrangement, setArrangement]);
    return React.useMemo(() => ({ arrangement, setArrangement, toggle }), [arrangement, setArrangement, toggle]);
}
