import { describe, expect, it } from 'vitest';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { readScmDiffSummaryPublicationReceipt } from './publicationReceipt';

const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'comparison', resultId: 'saved', revision: 2,
    metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
    comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {},
        inventory: { state: 'complete', reasons: [], files: [] } },
    requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
        title: 'Saved explanation', intro: '', stops: [], otherChangeRefs: [],
    } } }, analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
});

describe('saved result transcript receipt', () => {
    it('projects only a successful publication with its exact saved output and owner-supplied change', () => {
        const happier = { kind: 'scm_diff_summary.v1', payload: output };
        for (const change of ['created', 'updated'] as const) {
            const publication = { status: 'published', canUndo: true, outputs: [{ kind: 'walkthrough', change }] };
            expect(readScmDiffSummaryPublicationReceipt({ happier, scmResultUpdate: publication }))
                .toEqual({ output, publication });
        }
        expect(readScmDiffSummaryPublicationReceipt({ happier })).toBeNull();
        expect(readScmDiffSummaryPublicationReceipt({ happier, scmResultUpdate: { status: 'revision_conflict', latestRevision: 3 } })).toBeNull();
        expect(readScmDiffSummaryPublicationReceipt({ happier, scmResultUpdate: { status: 'invalid_output' } })).toBeNull();
    });

    it('does not fabricate a receipt for missing identity, failed output, or an unpublished output kind', () => {
        const publication = { status: 'published', canUndo: false, outputs: [{ kind: 'walkthrough', change: 'created' }] };
        const meta = (payload: unknown) => ({ happier: { kind: 'scm_diff_summary.v1', payload }, scmResultUpdate: publication });
        expect(readScmDiffSummaryPublicationReceipt(meta({ ...output, resultId: undefined }))).toBeNull();
        expect(readScmDiffSummaryPublicationReceipt(meta({ ...output, revision: undefined }))).toBeNull();
        expect(readScmDiffSummaryPublicationReceipt(meta({ ...output, success: false, error: 'Failed', errorCode: 'SUMMARY_FAILED' }))).toBeNull();
        expect(readScmDiffSummaryPublicationReceipt(meta({ ...output, outputs: { walkthrough: { state: 'failed' } } }))).toBeNull();
        expect(readScmDiffSummaryPublicationReceipt({ ...meta(output), scmResultUpdate: {
            ...publication, outputs: [{ kind: 'commitPlan', change: 'created' }],
        } })).toBeNull();
    });

    it('keeps owner update facts and refuses facts from another revision', () => {
        const publication = { status: 'published', canUndo: true, outputs: [{ kind: 'walkthrough', change: 'updated' }],
            updateNotice: { kind: 'generation', revision: 2, affectedStopIds: ['second', 'third'], mergedStopIds: ['second', 'third'] },
            titleEditKept: true };
        const meta = { happier: { kind: 'scm_diff_summary.v1', payload: output }, scmResultUpdate: publication };
        expect(readScmDiffSummaryPublicationReceipt(meta)?.publication).toEqual(publication);
        expect(readScmDiffSummaryPublicationReceipt({ ...meta, scmResultUpdate: { ...publication,
            updateNotice: { ...publication.updateNotice, revision: 3 } } })).toBeNull();
    });
});
