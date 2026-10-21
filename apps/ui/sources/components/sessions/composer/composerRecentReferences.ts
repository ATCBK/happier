import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionGrammar';
import type { ComposerSessionSuggestionItem } from '@/sync/domains/input/suggestionSession';
import type { RecentComposerReferenceInsertion } from './composerReferenceInsertion';
import { MENTION_KIND_V1, parseMentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { formatInlineReferenceTokenV1, INLINE_REFERENCE_ATTACHMENT_SCHEME_V1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { buildComposerFileReferenceSelection, buildComposerSessionReferenceSelection } from '@/sync/domains/input/composerReferenceSelection';

/** A Recent pick uses the current host's candidate and effect, never a previous host's closure. */
export async function applyRecentComposerSkillSelection(candidate: AutocompleteSuggestion | undefined, unavailableMessage: string): ReturnType<NonNullable<AutocompleteSuggestion['selectionEffect']>> {
    if (!candidate || candidate.disabled === true) return { ok: false, message: unavailableMessage };
    return candidate.selectionEffect ? candidate.selectionEffect() : { ok: true };
}

export function buildComposerRecentReferenceSuggestions(input: Readonly<{
    inserted: readonly RecentComposerReferenceInsertion[];
    files: readonly string[];
    sessions: readonly (Pick<ComposerSessionSuggestionItem, 'id' | 'title'> & Partial<Pick<ComposerSessionSuggestionItem, 'workspaceLabel' | 'agentLabel'>>)[];
    kinds: readonly ComposerSuggestionKindId[];
    group: string;
    /** Only the current composer's usable tray ids have attachment custody. */
    attachmentIds?: readonly string[];
    /** A session row's second line when it has no folder or Agent to name (keeps every row two lines). */
    sessionKindLabel?: string;
    skillSelectionEffect?: (reference: Readonly<{ ref: string; label: string }>) => NonNullable<AutocompleteSuggestion['selectionEffect']>;
}>): AutocompleteSuggestion[] {
    const attachmentIds = new Set(input.attachmentIds);
    const candidates: Array<Readonly<{ reference: string; suggestion: AutocompleteSuggestion }>> = input.inserted.filter(({ reference }) => {
        const parsed = parseMentionRefV1(reference.ref);
        return parsed?.scheme !== INLINE_REFERENCE_ATTACHMENT_SCHEME_V1 || attachmentIds.has(parsed.opaque);
    }).map(({ reference, suggestion }) => ({ reference: reference.ref, suggestion: {
        kind: suggestion?.kind ?? (reference.kind === MENTION_KIND_V1.file ? 'file'
            : reference.kind === MENTION_KIND_V1.session ? 'session'
                : reference.kind === MENTION_KIND_V1.skill ? 'skill'
                    : reference.kind === MENTION_KIND_V1.vendorPlugin ? 'vendorPlugin' : 'composerReference'),
        key: suggestion?.key ?? reference.ref,
        label: reference.label,
        text: formatInlineReferenceTokenV1(reference),
        structuredInput: suggestion?.structuredInput ?? reference.payload ?? { kind: reference.kind, ref: reference.ref, label: reference.label },
        ...(suggestion?.description ? { description: suggestion.description } : {}),
        ...(suggestion?.component ? { component: suggestion.component } : {}),
        ...(suggestion?.icon ? { icon: suggestion.icon } : {}),
    } }));
    for (const path of input.files) {
        const label = path.split('/').at(-1) || path;
        const selection = buildComposerFileReferenceSelection(path, label);
        candidates.push({ reference: selection.ref, suggestion: { kind: 'file', key: `file-${path}`, text: selection.token, label,
            description: path, structuredInput: selection.payload } });
    }
    for (const session of input.sessions) {
        const selection = buildComposerSessionReferenceSelection(session);
        candidates.push({ reference: selection.ref, suggestion: { kind: 'session', key: `session-${session.id}`, text: selection.token,
            label: session.title, structuredInput: selection.payload,
            // The same second line the Sessions section gives its rows (lab P1).
            description: session.workspaceLabel ?? session.agentLabel ?? input.sessionKindLabel } });
    }
    const seen = new Set<string>();
    return candidates.flatMap(({ suggestion: candidate, reference: identity }) => {
        if (!input.kinds.includes(candidate.kind)) return [];
        if (seen.has(identity)) return [];
        seen.add(identity);
        return [{ ...candidate, group: input.group,
            ...(candidate.kind === 'skill' && input.skillSelectionEffect
                ? { selectionEffect: input.skillSelectionEffect({ ref: identity, label: candidate.label ?? candidate.text }) } : {}) }];
    });
}
