import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useCallback } from 'react';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';

export function useSessionListStorageKind(): Readonly<{
    externalSessionsEnabled: boolean;
    storageKind: SessionListStorageFilter;
    setStorageKind: (storageKind: SessionListStorageFilter) => void;
}> {
    const externalSessionsDecision = useFeatureDecision('sessions.direct');
    const externalSessionsEnabled = externalSessionsDecision?.state === 'enabled';
    const sessionsListStorageFilter = useLocalSetting('sessionsListStorageFilter');
    const setSessionsListStorageFilter = useCallback((next: SessionListStorageFilter) => {
        getStorage().getState().applyLocalSettings({ sessionsListStorageFilter: next }, { source: 'ui' });
    }, []);

    return {
        externalSessionsEnabled,
        storageKind: externalSessionsEnabled ? sessionsListStorageFilter : 'persisted',
        setStorageKind: setSessionsListStorageFilter,
    };
}
