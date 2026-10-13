import { getPreferredLanguage } from '@/text';

/** "a, b and c" in the reader's language. */
export function joinList(parts: readonly string[], locale: string = getPreferredLanguage()): string {
    try {
        return new Intl.ListFormat(locale, { type: 'conjunction', style: 'long' }).format(parts);
    } catch {
        return parts.join(', ');
    }
}
