import * as React from 'react';
import { getStorage, useLocalSetting } from '@/sync/domains/state/storage';
import type { PaneArrangement } from '@/components/ui/panels/paneBreakpoints';

export function usePaneArrangement() {
    const value = useLocalSetting('paneArrangement');
    const arrangement: PaneArrangement = value === 'editor' ? 'editor' : 'session';
    const setArrangement = React.useCallback((next: PaneArrangement) => {
        getStorage().getState().applyLocalSettings({ paneArrangement: next }, { source: 'ui' });
    }, []);
    const toggle = React.useCallback(() => setArrangement(arrangement === 'editor' ? 'session' : 'editor'), [arrangement, setArrangement]);
    return React.useMemo(() => ({ arrangement, setArrangement, toggle }), [arrangement, setArrangement, toggle]);
}
