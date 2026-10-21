/**
 * Composer suggestion TOKENS — trigger declarations, the kind -> trigger map
 * (INV-1), and the per-trigger token grammar.
 *
 * A composer suggestion token is `<trigger><value>` (optionally a quoted span).
 * This module decides where a token ends and how its query is read back, using
 * Protocol's shared boundaries and formatter for composer and Agent markers.
 *
 * The detector (`findActiveWord`) and every token formatter share it, so a token
 * the picker inserts always re-parses to the same span (INV-3). Grammar is per
 * TRIGGER, never per kind: two kinds sharing `@` share one token shape.
 *
 * This module has NO React or sync dependencies on purpose: the detector and the
 * composer hosts must be able to resolve triggers without pulling the candidate
 * resolvers or row components in `composerSuggestionKinds.ts`.
 */

import { isComposerTokenBoundaryChar, isComposerTokenWhitespaceChar } from '@happier-dev/protocol/runtime/input/composerSuggestionTokenV1';
export { formatComposerSuggestionToken, isComposerTokenBoundaryChar } from '@happier-dev/protocol/runtime/input/composerSuggestionTokenV1';

export const COMPOSER_SUGGESTION_TRIGGERS = ['@', '$', '/'] as const;

export type ComposerSuggestionTrigger = (typeof COMPOSER_SUGGESTION_TRIGGERS)[number];

type ComposerSuggestionTokenGrammar = Readonly<{
    /**
     * Whether `<trigger>"…"` spans are available for this trigger.
     *
     * Public Composer-reference providers may use any admitted trigger, and
     * their bounded display labels may contain spaces. Every trigger therefore
     * needs the same quoted-span escape even though built-in skill and command
     * names do not normally exercise it.
     */
    quoting: boolean;
}>;

const COMPOSER_SUGGESTION_TOKEN_GRAMMAR = {
    '@': { quoting: true },
    $: { quoting: true },
    '/': { quoting: true },
} as const satisfies Record<ComposerSuggestionTrigger, ComposerSuggestionTokenGrammar>;

export function isComposerSuggestionTrigger(value: string): value is ComposerSuggestionTrigger {
    return (COMPOSER_SUGGESTION_TRIGGERS as readonly string[]).includes(value);
}

/** Whitespace, or the end of the content. `charAt` returns `''` past the end. */
function isTokenWhitespaceOrEnd(char: string): boolean {
    return isComposerTokenWhitespaceChar(char);
}

/**
 * Whether the `"` at `quoteIndex` opens a quoted span, or is just a quote.
 *
 * A quoted span suspends the whitespace rule so one token can hold a name with
 * spaces, which means an opening quote that no value follows turns the rest of
 * the line into a single token — `"@"` written in prose held the picker open
 * across every word after it until the line ended.
 *
 * Requiring a value means the two shapes separate cleanly: `@"my session"` is a
 * search, `"@"` is the mention character in quotation marks. The cost is that a
 * value beginning with whitespace has no representation, since quoting is the
 * only thing that could carry it; no candidate source produces one.
 */
function opensQuotedSpan(content: string, quoteIndex: number): boolean {
    return content.charAt(quoteIndex) === '"' && !isTokenWhitespaceOrEnd(content.charAt(quoteIndex + 1));
}

/**
 * Returns the exclusive end offset of the token that starts at `triggerIndex`.
 *
 * Used for BOTH the backward and the forward half of detection, so the two can
 * never disagree about where a token ends.
 */
export function parseComposerTokenEnd(content: string, triggerIndex: number, maxEnd: number): number {
    const trigger = content.charAt(triggerIndex);
    const grammar = isComposerSuggestionTrigger(trigger)
        ? COMPOSER_SUGGESTION_TOKEN_GRAMMAR[trigger]
        : null;
    let index = triggerIndex + 1;

    if (grammar?.quoting && opensQuotedSpan(content, index)) {
        index += 1;
        while (index < maxEnd) {
            const char = content.charAt(index);
            // A token never crosses a line, even unterminated.
            if (char === '\n' || char === '\r') return index;
            if (char === '"') {
                // `""` is an escaped quote inside the span; a lone `"` closes it.
                if (content.charAt(index + 1) === '"') {
                    index += 2;
                    continue;
                }
                return index + 1;
            }
            index += 1;
        }
        return index;
    }

    while (index < maxEnd && !isComposerTokenBoundaryChar(content.charAt(index))) {
        index += 1;
    }
    return index;
}

/**
 * Splits an active word into its trigger and its search query, unquoting a
 * quoted span. `@"my file.ts"` searches for `my file.ts`, not `"my file.ts"`.
 */
export function parseComposerSuggestionQuery(activeWord: string): Readonly<{
    trigger: ComposerSuggestionTrigger;
    query: string;
}> | null {
    const trigger = activeWord.charAt(0);
    if (!isComposerSuggestionTrigger(trigger)) return null;

    const rest = activeWord.slice(1);
    if (!COMPOSER_SUGGESTION_TOKEN_GRAMMAR[trigger].quoting || !rest.startsWith('"')) {
        return { trigger, query: rest };
    }

    const body = rest.length >= 2 && rest.endsWith('"') ? rest.slice(1, -1) : rest.slice(1);
    return { trigger, query: body.replace(/""/g, '"') };
}

export const COMPOSER_SUGGESTION_KIND_IDS = [
    'file',
    'vendorPlugin',
    'session',
    'composerReference',
    'skill',
    'slashCommand',
    'accountMention',
] as const;

export type ComposerSuggestionKindId = (typeof COMPOSER_SUGGESTION_KIND_IDS)[number];

/**
 * The single trigger -> kind mapping (INV-1). Hosts declare an eligible-kind
 * subset; nothing outside this module turns a kind into a trigger character.
 * A manifest-declared composer reference may lawfully use more than one token.
 */
const COMPOSER_SUGGESTION_KIND_TRIGGERS = {
    file: ['@'],
    vendorPlugin: ['@'],
    session: ['@'],
    composerReference: COMPOSER_SUGGESTION_TRIGGERS,
    skill: ['$'],
    slashCommand: ['/'],
    accountMention: ['@'],
} as const satisfies Record<ComposerSuggestionKindId, readonly ComposerSuggestionTrigger[]>;

export function resolveComposerSuggestionTriggersForKind(
    kind: ComposerSuggestionKindId,
): readonly ComposerSuggestionTrigger[] {
    return COMPOSER_SUGGESTION_KIND_TRIGGERS[kind];
}

/** The trigger characters a host offering `kinds` detects, in declaration order. */
export function resolveComposerSuggestionTriggers(
    kinds: readonly ComposerSuggestionKindId[],
): readonly ComposerSuggestionTrigger[] {
    return COMPOSER_SUGGESTION_TRIGGERS.filter(
        (trigger) => kinds.some((kind) => resolveComposerSuggestionTriggersForKind(kind).includes(trigger)),
    );
}

/** The eligible kind ids a host offers for one trigger, in declaration order. */
export function resolveComposerSuggestionKindIdsForTrigger(
    kinds: readonly ComposerSuggestionKindId[],
    trigger: ComposerSuggestionTrigger,
): readonly ComposerSuggestionKindId[] {
    return COMPOSER_SUGGESTION_KIND_IDS.filter(
        (kind) => kinds.includes(kind) && resolveComposerSuggestionTriggersForKind(kind).includes(trigger),
    );
}
