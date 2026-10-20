import { getPreferredLanguage, t } from '@/text';
import { joinList } from '@/utils/text/joinList';

/** "Claude, Codex and OpenCode" in the reader's language (or `locale`). */
export function formatAgentNameList(names: readonly string[], locale?: string): string {
    return joinList(names, locale);
}

/**
 * The list for a line that must not wrap or cut a name: up to `shown` names, then the rest as a count ("Claude, Codex
 * and 7 more"). A list that is one name over `shown` is written out, because "and 1 more" says less than the name.
 */
export function formatAgentNameListFolded(names: readonly string[], shown = 2, locale?: string): string {
    if (names.length <= shown + 1) return formatAgentNameList(names, locale);
    return formatAgentNameList([...names.slice(0, shown), t('capabilities.where.more', { count: names.length - shown })], locale);
}

export type AgentNameListPart = Readonly<{ kind: 'name'; index: number }> | Readonly<{ kind: 'literal'; text: string }>;

/**
 * The same list as parts, so each name can carry its mark: names by their index in `names`, and the
 * separators ("", ", ", " and ") as the reader's language writes them.
 */
export function formatAgentNameListParts(names: readonly string[], locale: string = getPreferredLanguage()): readonly AgentNameListPart[] {
    // Placeholders that no list formatter rewrites, mapped back to the names' indexes.
    const tokens = names.map((_, index) => `\u0001${index}\u0001`);
    let parts: readonly Readonly<{ type: string; value: string }>[];
    try {
        parts = new Intl.ListFormat(locale, { type: 'conjunction', style: 'long' }).formatToParts(tokens);
    } catch {
        parts = tokens.flatMap((value, index) => index === 0 ? [{ type: 'element', value }] : [{ type: 'literal', value: ', ' }, { type: 'element', value }]);
    }
    return parts.map((part) => {
        const index = part.type === 'element' ? tokens.indexOf(part.value) : -1;
        return index >= 0 ? { kind: 'name' as const, index } : { kind: 'literal' as const, text: part.value };
    });
}
