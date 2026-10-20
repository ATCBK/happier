import * as React from 'react';

import { useLocalSetting } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';

import type { PetCompanionTrayItem } from './petCompanionActivityTypes';
import {
    appendDismissedPetCompanionTrayItemKey,
    normalizeDismissedPetCompanionTrayItemKeys,
} from './petCompanionTrayDismissal';

export function usePetCompanionTrayDismissals(): Readonly<{
    dismissedTrayItemKeys: ReadonlySet<string>;
    dismissTrayItem: (item: PetCompanionTrayItem) => void;
}> {
    const persistedDismissedTrayItemKeys = useLocalSetting('petsDismissedCompanionTrayItemKeys');
    const [optimisticDismissedKeys, setOptimisticDismissedKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const persistedDismissedKeys = React.useMemo(
        () => normalizeDismissedPetCompanionTrayItemKeys(persistedDismissedTrayItemKeys),
        [persistedDismissedTrayItemKeys],
    );
    const dismissedTrayItemKeys = React.useMemo(
        () => new Set([...persistedDismissedKeys, ...optimisticDismissedKeys]),
        [optimisticDismissedKeys, persistedDismissedKeys],
    );
    const dismissTrayItem = React.useCallback((item: PetCompanionTrayItem) => {
        setOptimisticDismissedKeys((current) => {
            if (current.has(item.dismissKey)) return current;
            const next = new Set(current);
            next.add(item.dismissKey);
            return next;
        });
        getStorage().getState().applyLocalSettings({
            petsDismissedCompanionTrayItemKeys: appendDismissedPetCompanionTrayItemKey(
                [...dismissedTrayItemKeys],
                item.dismissKey,
            ),
        }, { source: 'ui' });
    }, [dismissedTrayItemKeys]);

    return { dismissedTrayItemKeys, dismissTrayItem };
}
