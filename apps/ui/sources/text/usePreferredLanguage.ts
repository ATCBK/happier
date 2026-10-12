import { useSyncExternalStore } from 'react';

import { getPreferredLanguage, subscribePreferredLanguage, type SupportedLanguage } from './i18n';

/** The active, ready locale: use it to invalidate translated presentation projections. */
export function usePreferredLanguage(): SupportedLanguage {
    return useSyncExternalStore(subscribePreferredLanguage, getPreferredLanguage, getPreferredLanguage);
}
