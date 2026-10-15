import { formatHappierAsOfTime } from '@happier-dev/plugin-ui/presentation';
import { getPreferredLanguage } from '@/text';

/**
 * When cached facts were read, as a person says it ("10:42", "26 Sep, 18:44"). One formatter for the
 * host's freshness lines and the public plugin `FreshnessLine`, owned by the shared presentation, in the
 * language the rest of the app shows its times in.
 */
export function formatAsOfTime(at: number, now?: number): string {
    return formatHappierAsOfTime(at, now, getPreferredLanguage());
}
