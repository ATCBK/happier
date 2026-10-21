import { describe, expect, it } from 'vitest';
import { applyRecentComposerSkillSelection, buildComposerRecentReferenceSuggestions } from './composerRecentReferences';
import { recordComposerReferenceInsertion, recordComposerReferencePublication, readRecentComposerReferenceInsertions } from './composerReferenceInsertion';

describe('Recent composer references', () => {
    it('refreshes recency when a successful insertion replaces an equal reference occurrence', () => {
        const scope = { serverId: 'replacement-recent-home', accountId: 'account' };
        const workflow = { kind: 'happier.workflow', ref: 'workflow:review', label: 'Review' };
        recordComposerReferenceInsertion(scope, workflow);
        recordComposerReferenceInsertion(scope, { kind: 'happier.widget', ref: 'widget:build', label: 'Build' });
        const token = '[Review](happier-ref:workflow:review)';
        const snapshot = { text: token, references: [{ ...workflow, token, start: 0, end: token.length }] };
        recordComposerReferencePublication({ scope, next: snapshot, insertedRefs: [workflow.ref] });
        expect(readRecentComposerReferenceInsertions(scope)[0]?.reference.ref).toBe(workflow.ref);
    });
    it('offers attachment references only while this composer still owns a usable tray item', () => {
        const scope = { serverId: 'attachment-recent-home', accountId: 'account' };
        recordComposerReferenceInsertion(scope, { kind: 'attachment', ref: 'attachment:local-image', label: 'photo.png' });
        recordComposerReferenceInsertion(scope, { kind: 'happier.workflow', ref: 'workflow:review', label: 'Review' });
        const input = { inserted: readRecentComposerReferenceInsertions(scope), files: [], sessions: [],
            kinds: ['composerReference'] as const, group: 'Recent' };
        const currentDraft = buildComposerRecentReferenceSuggestions({ ...input, attachmentIds: ['local-image'] });
        expect(currentDraft.map(row => row.label)).toEqual(['Review', 'photo.png']);
        // Another draft, or the original after remove/send, no longer has custody of the upload.
        for (const attachmentIds of [undefined, []]) {
            expect(buildComposerRecentReferenceSuggestions({ ...input, attachmentIds }).map(row => row.label))
                .toEqual(['Review']);
        }
    });
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
