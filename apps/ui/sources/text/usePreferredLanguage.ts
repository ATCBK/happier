import { useSyncExternalStore } from 'react';

import type { SupportedLanguage } from './_all';
import { getPreferredLanguage, subscribePreferredLanguage } from './preferredLanguage';

/** The active, ready locale: use it to invalidate translated presentation projections. */
export function usePreferredLanguage(): SupportedLanguage {
    return useSyncExternalStore(subscribePreferredLanguage, getPreferredLanguage, getPreferredLanguage);
}
