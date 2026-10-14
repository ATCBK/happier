import * as React from 'react';
import { getPreferredLanguage } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { createRootStackRouteOptions } from './rootStackRouteOptions';

export function useRootStackRouteOptions() {
    const mode = useSetting('newSessionPresentationModeV1');
    const language = getPreferredLanguage();
    return React.useMemo(() => createRootStackRouteOptions(mode), [mode, language]);
}
