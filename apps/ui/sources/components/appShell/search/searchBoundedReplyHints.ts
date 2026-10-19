import { t } from '@/text';

/**
 * The one rule for a search group whose reply stopped at a bound (a truncated corpus, a full page).
 * With rows it points at the rest; with none it only says what was searched, since a group that shows
 * nothing cannot promise "more results are available".
 */
export function boundedReplyHints(input: Readonly<{ rowCount: number; incomplete: boolean }>): Readonly<{ emptyHint?: string; resultHint?: string }> {
    if (!input.incomplete) return {};
    return input.rowCount === 0
        ? { emptyHint: t('universalSearch.noMatchesInSearchedResults') }
        : { resultHint: t('universalSearch.moreResultsAvailable') };
}
