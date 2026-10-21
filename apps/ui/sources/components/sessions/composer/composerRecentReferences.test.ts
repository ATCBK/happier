import { describe, expect, it } from 'vitest';
import { applyRecentComposerSkillSelection, buildComposerRecentReferenceSuggestions } from './composerRecentReferences';
import { recordComposerReferenceInsertion, readRecentComposerReferenceInsertions } from './composerReferenceInsertion';

describe('Recent composer references', () => {
    it('refuses a skill candidate disabled by the current host before inserting its Recent reference', async () => {
        expect(await applyRecentComposerSkillSelection({ kind: 'skill', key: 'library-review', text: '$review',
            disabled: true, structuredInput: { kind: 'skill', id: 'review', name: 'review' } }, 'unavailable'))
            .toEqual({ ok: false, message: 'unavailable' });
    });
    it('resolves a recent skill selection effect by its canonical identity', async () => {
        const scope = { serverId: 'skill-home', accountId: 'account' };
        const reference = { label: 'Review', ref: 'skill:vendor:agent:review', kind: 'happier.skill' };
        recordComposerReferenceInsertion(scope, reference, { kind: 'skill', key: 'library-review', text: '$review',
            structuredInput: { kind: 'skill', id: 'vendor:agent:review', name: 'review' } });
        let selectedRef: string | null = null;
        const suggestions = buildComposerRecentReferenceSuggestions({ inserted: readRecentComposerReferenceInsertions(scope),
            files: [], sessions: [], kinds: ['skill'], group: 'Recent', skillSelectionEffect: selected => async () => {
                selectedRef = selected.ref;
                return { ok: true };
            } });
        await suggestions[0]?.selectionEffect?.();
        expect(selectedRef).toBe(reference.ref);
    });
    it('does not reinterpret a relative file from another workspace in this Home', () => {
        const scope = { serverId: 'workspace-home', accountId: 'account' };
        const workspace = { serverId: scope.serverId, machineId: 'machine', rootPath: '/repo-a' };
        const reference = { label: 'a.ts', ref: 'file:src/a.ts', kind: 'happier.file' };
        recordComposerReferenceInsertion(scope, reference, undefined, workspace);
        expect(readRecentComposerReferenceInsertions(scope, { ...workspace, rootPath: '/repo-b' })).toEqual([]);
        expect(readRecentComposerReferenceInsertions(scope, workspace)).toHaveLength(1);
    });
    it('merges this run, quick-open files and Session activity without duplicates or a new cap', () => {
        const scope = { serverId: 'recent-home', accountId: 'recent-account' };
        const workspace = { serverId: scope.serverId, machineId: 'machine', rootPath: '/repo' };
        const reference = { label: 'a.ts', ref: 'file:src/a.ts', kind: 'happier.file' };
        recordComposerReferenceInsertion(scope, reference, { kind: 'file', key: 'file-src/a.ts', text: '', structuredInput: reference }, workspace);
        const suggestions = buildComposerRecentReferenceSuggestions({
            inserted: readRecentComposerReferenceInsertions(scope, workspace),
            files: Array.from({ length: 25 }, (_, index) => `src/${index}.ts`).concat('src/a.ts'),
            sessions: [{ id: 's1', title: 'Auth fix' }],
            kinds: ['file', 'session'], group: 'Recent',
        });
        expect(suggestions).toHaveLength(27);
        expect(suggestions[0]?.structuredInput).toMatchObject({ ref: reference.ref });
        expect(suggestions.at(-1)?.structuredInput).toMatchObject({ ref: 'session:s1' });
        expect(readRecentComposerReferenceInsertions({ ...scope, accountId: 'other' })).toEqual([]);
    });
});
