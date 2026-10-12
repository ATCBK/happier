import * as React from 'react';

import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { useProfile } from '@/sync/domains/state/storage';
import { t } from '@/text';

/** Morning from 5:00, afternoon from 12:00, evening from 18:00 until the next morning. */
export function resolveHomeGreeting(input: Readonly<{ hour: number; name: string | null }>): string {
    const { hour, name } = input;
    const part = hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : 'evening';
    if (!name) {
        return part === 'morning'
            ? t('homeIndex.greetingMorningAnonymous')
            : part === 'afternoon' ? t('homeIndex.greetingAfternoonAnonymous') : t('homeIndex.greetingEveningAnonymous');
    }
    return part === 'morning'
        ? t('homeIndex.greetingMorning', { name })
        : part === 'afternoon' ? t('homeIndex.greetingAfternoon', { name }) : t('homeIndex.greetingEvening', { name });
}

/** Home's hero line: "Good afternoon, Leeroy". The hour is read when Home mounts. */
export function useHomeGreeting(): string {
    const profile = useProfile();
    // A greeting uses the first word of the canonical account label.
    const name = formatAccountDisplayName(profile)?.split(/\s+/)[0] || null;
    const [hour] = React.useState(() => new Date().getHours());
    return resolveHomeGreeting({ hour, name });
}
