import * as React from 'react';
import { createTwoFilesPatch } from 'diff';
import { parseUnifiedDiffHunks, revertHunks, type Hunk } from '@happier-dev/protocol/diff/hunks';

export type EditorComparisonInput = Readonly<{
    baseText: string | null;
    mineText: string;
    theirsText: string;
    theirsHash: string;
}>;
export type EditorComparisonResolution = Readonly<{ text: string; baseText: string; baseHash: string }>;
export type EditorComparisonPlace = Readonly<{ hunk: Hunk; choice: 'mine' | 'theirs' | null; automatic: boolean }>;
export type EditorComparison = EditorComparisonInput & Readonly<{
    places: readonly EditorComparisonPlace[];
    mergedText: string;
    error: 'moved_on' | 'overlap' | 'invalid_hunk' | null;
}>;

export type WorkspaceFileEditorComparisonController = Readonly<{
    comparison: EditorComparison | null;
    startComparison: (snapshot: EditorComparisonInput) => void;
    usePlaceMine: (index: number) => void;
    usePlaceTheirs: (index: number) => void;
    useAllMine: () => void;
    useAllTheirs: () => void;
    backToEditing: () => void;
}>;

function textHunks(oldText: string, newText: string): readonly Hunk[] {
    // Zero context makes each changed place independently selectable. The renderer
    // consumes these same snapshots with contextLines=0 and the shared hunk indices.
    return parseUnifiedDiffHunks(createTwoFilesPatch('file', 'file', oldText, newText, '', '', { context: 0 }));
}

function newSideRange(hunk: Hunk) {
    const start = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    return { start, end: start + hunk.newLines };
}

function touchesMine(place: Hunk, mine: Hunk): boolean {
    // Both diffs end at the original draft, so their new-side coordinates share
    // one basis even when disk edits insert/delete lines before a later place.
    const a = newSideRange(place);
    const b = newSideRange(mine);
    if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
    if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
    return a.start < b.end && b.start < a.end;
}

export function useWorkspaceFileEditorComparison(input: Readonly<{
    ownerKey: string;
    onAccept: (resolution: EditorComparisonResolution) => void;
}>): WorkspaceFileEditorComparisonController {
    const [comparison, setComparison] = React.useState<EditorComparison | null>(null);
    const comparisonRef = React.useRef(comparison);
    const inputRef = React.useRef(input);
    inputRef.current = input;
    const [ownerKey, setOwnerKey] = React.useState(input.ownerKey);
    if (ownerKey !== input.ownerKey) {
        comparisonRef.current = null;
        setOwnerKey(input.ownerKey);
        setComparison(null);
    }

    const publish = React.useCallback((next: EditorComparison | null) => {
        comparisonRef.current = next;
        setComparison(next);
    }, []);

    const decide = React.useCallback((next: EditorComparison) => {
        if (inputRef.current.ownerKey !== input.ownerKey) return;
        // Always compose on the immutable original draft: earlier choices may
        // change line counts, and revising a choice must not accumulate edits.
        const result = revertHunks(next.mineText, next.places.filter(place => place.choice === 'theirs').map(place => place.hunk));
        if (!result.ok) {
            publish({ ...next, error: result.reason });
            return;
        }
        if (next.places.every(place => place.choice !== null)) {
            publish(null);
            inputRef.current.onAccept({ text: result.text, baseText: next.theirsText, baseHash: next.theirsHash });
        } else {
            publish({ ...next, mergedText: result.text, error: null });
        }
    }, [input.ownerKey, publish]);

    const startComparison = React.useCallback((snapshot: EditorComparisonInput) => {
        if (inputRef.current.ownerKey !== input.ownerKey) return;
        const mine = snapshot.baseText === null ? null : textHunks(snapshot.baseText, snapshot.mineText);
        const places = textHunks(snapshot.theirsText, snapshot.mineText).map(hunk => {
            const automatic = mine !== null && !mine.some(change => touchesMine(hunk, change));
            return { hunk, choice: automatic ? 'theirs' as const : null, automatic };
        });
        decide({ ...snapshot, places, mergedText: snapshot.mineText, error: null });
    }, [decide, input.ownerKey]);

    const choose = React.useCallback((choice: 'mine' | 'theirs', index?: number) => {
        const current = comparisonRef.current;
        if (!current || inputRef.current.ownerKey !== input.ownerKey) return;
        if (index !== undefined && !current.places.some(place => place.hunk.index === index)) return;
        decide({ ...current, places: current.places.map(place => index === undefined || place.hunk.index === index
            ? { ...place, choice, automatic: false } : place) });
    }, [decide, input.ownerKey]);
    const usePlaceMine = React.useCallback((index: number) => choose('mine', index), [choose]);
    const usePlaceTheirs = React.useCallback((index: number) => choose('theirs', index), [choose]);
    const useAllMine = React.useCallback(() => choose('mine'), [choose]);
    const useAllTheirs = React.useCallback(() => choose('theirs'), [choose]);
    const backToEditing = React.useCallback(() => {
        if (inputRef.current.ownerKey === input.ownerKey) publish(null);
    }, [input.ownerKey, publish]);
    return { comparison, startComparison, usePlaceMine, usePlaceTheirs, useAllMine, useAllTheirs, backToEditing };
}
