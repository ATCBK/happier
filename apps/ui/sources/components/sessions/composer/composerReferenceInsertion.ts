import type { ComposerOperationV1, ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { isComposerTokenBoundaryChar } from '@/components/autocomplete/composerSuggestionGrammar';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { MENTION_KIND_V1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

type ComposerReference = ComposerSnapshotV1['references'][number];
export type ComposerReferenceInsertion = Readonly<{
    label: string;
    ref: string;
    kind: string;
    payload?: Omit<ComposerReference, 'token' | 'start' | 'end'>;
}>;

export type RecentComposerReferenceInsertion = Readonly<{
    reference: ComposerReferenceInsertion;
    suggestion?: Pick<AutocompleteSuggestion, 'kind' | 'key' | 'label' | 'structuredInput'>;
    workspaceKey?: string;
}>;
const insertedByHome = new Map<string, readonly RecentComposerReferenceInsertion[]>();

/** Called after the document owner accepts an insertion; planning alone is not a mention. */
export function recordComposerReferenceInsertion(scope: ServerAccountScope, reference: ComposerReferenceInsertion, suggestion?: AutocompleteSuggestion,
    workspace?: WorkspaceScopeBase | null): void {
    const key = serverAccountScopeKeySuffix(scope);
    const workspaceKey = reference.kind === MENTION_KIND_V1.file && workspace ? tryBuildWorkspaceCacheKey(workspace) : null;
    insertedByHome.set(key, [{ reference, ...(workspaceKey ? { workspaceKey } : {}), ...(suggestion ? { suggestion: { kind: suggestion.kind, key: suggestion.key,
        label: suggestion.label, structuredInput: suggestion.structuredInput } } : {}) },
        ...(insertedByHome.get(key) ?? []).filter(item => item.reference.ref !== reference.ref || item.workspaceKey !== (workspaceKey ?? undefined))]);
}

export function readRecentComposerReferenceInsertions(scope: ServerAccountScope, workspace?: WorkspaceScopeBase | null): readonly RecentComposerReferenceInsertion[] {
    const workspaceKey = workspace ? tryBuildWorkspaceCacheKey(workspace) : null;
    return (insertedByHome.get(serverAccountScopeKeySuffix(scope)) ?? []).filter(item => item.reference.kind !== MENTION_KIND_V1.file
        || Boolean(workspaceKey && item.workspaceKey === workspaceKey));
}

/** Bound reference ranges are atomic in the shared composer-text offset space. */
export function snapComposerReferenceOffset(offset: number, references: readonly Readonly<{ start: number; end: number }>[]): number {
    const reference = references.find(item => offset > item.start && offset < item.end);
    if (!reference) return offset;
    return offset - reference.start <= reference.end - offset ? reference.start : reference.end;
}

export function planComposerReferenceInsertion(input: Readonly<{
    snapshot: Pick<ComposerSnapshotV1, 'text' | 'selection' | 'references'>;
    reference: ComposerReferenceInsertion;
    at: Readonly<{ kind: 'activeWord'; range: Readonly<{ start: number; end: number }> }>
        | Readonly<{ kind: 'offset'; offset: number }> | Readonly<{ kind: 'caret' }>;
}>): [
    Extract<ComposerOperationV1, { kind: 'text.insert' | 'text.replaceRange' }>,
    Extract<ComposerOperationV1, { kind: 'reference.insert' }>,
] {
    const { snapshot, reference, at } = input;
    const clamp = (offset: number) => Math.max(0, Math.min(snapshot.text.length, offset));
    let range = at.kind === 'activeWord' ? at.range : at.kind === 'offset'
        ? { start: at.offset, end: at.offset }
        : snapshot.selection ?? { start: snapshot.text.length, end: snapshot.text.length };
    range = { start: clamp(range.start), end: clamp(range.end) };
    const boundReferences = snapshot.references.filter(bound => snapshot.text.slice(bound.start, bound.end) === bound.token);
    if (range.start === range.end) {
        const offset = snapComposerReferenceOffset(range.start, boundReferences);
        range = { start: offset, end: offset };
    }
    for (const bound of boundReferences) {
        if (range.start !== range.end) {
            range = {
                start: range.start > bound.start && range.start < bound.end ? bound.start : range.start,
                end: range.end > bound.start && range.end < bound.end ? bound.end : range.end,
            };
        }
    }
    const token = formatInlineReferenceTokenV1(reference);
    const before = snapshot.text.charAt(range.start - 1);
    const after = snapshot.text.charAt(range.end);
    const prefix = before && (!isComposerTokenBoundaryChar(before) || boundReferences.some(item => item.end === range.start)) ? ' ' : '';
    // A reference that ends the text leaves the word boundary after it, so the next word typed at the
    // caret is never glued to the chip (its readable marker would otherwise run into that word).
    const suffix = !after || !isComposerTokenBoundaryChar(after) || boundReferences.some(item => item.start === range.end) ? ' ' : '';
    const start = range.start + prefix.length;
    const text = prefix + token + suffix;
    return [
        range.start === range.end
            ? { kind: 'text.insert', position: { offset: range.start }, text }
            : { kind: 'text.replaceRange', range, text },
        { kind: 'reference.insert', reference: { ...reference.payload, kind: reference.kind, ref: reference.ref,
            label: reference.label, token, start, end: start + token.length } },
    ];
}
