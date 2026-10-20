import React from 'react';

import { getStorage } from '@/sync/domains/state/storageStore';

export function useApplyBrandHeroSeen(): () => void {
    return React.useCallback(() => {
        getStorage().getState().applyLocalSettings({ brandHeroSeenAt: Date.now() }, { source: 'ui' });
    }, []);
}
