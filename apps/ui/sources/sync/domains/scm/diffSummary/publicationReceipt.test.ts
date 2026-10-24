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
        for (const change of ['created', 'updated'] as const) {
            const publication = { status: 'published', canUndo: true, outputs: [{ kind: 'walkthrough', change }] };
            expect(readScmDiffSummaryPublicationReceipt(output, publication))
                .toEqual({ output, publication });
        }
        expect(readScmDiffSummaryPublicationReceipt(output, undefined)).toBeNull();
        expect(readScmDiffSummaryPublicationReceipt(output, { status: 'revision_conflict', latestRevision: 3 })).toBeNull();
        expect(readScmDiffSummaryPublicationReceipt(output, { status: 'invalid_output' })).toBeNull();
    });

    it('does not fabricate a receipt for missing identity, failed output, or an unpublished output kind', () => {
        const publication = { status: 'published', canUndo: false, outputs: [{ kind: 'walkthrough', change: 'created' }] };
        for (const admitted of [
            ScmDiffSummaryGenerateOutputSchema.parse({ ...output, resultId: undefined }),
            ScmDiffSummaryGenerateOutputSchema.parse({ ...output, revision: undefined }),
            ScmDiffSummaryGenerateOutputSchema.parse({ success: false, error: 'Failed', errorCode: 'SUMMARY_FAILED' }),
            ScmDiffSummaryGenerateOutputSchema.parse({ ...output, outputs: { walkthrough: { state: 'failed' } } }),
        ]) expect(readScmDiffSummaryPublicationReceipt(admitted, publication)).toBeNull();
        expect(readScmDiffSummaryPublicationReceipt(output, {
            ...publication, outputs: [{ kind: 'commitPlan', change: 'created' }],
        })).toBeNull();
    });

    it('keeps owner update facts and refuses facts from another revision', () => {
        const publication = { status: 'published', canUndo: true, outputs: [{ kind: 'walkthrough', change: 'updated' }],
            updateNotice: { kind: 'generation', revision: 2, affectedStopIds: ['second', 'third'], mergedStopIds: ['second', 'third'] },
            titleEditKept: true };
        expect(readScmDiffSummaryPublicationReceipt(output, publication)?.publication).toEqual(publication);
        expect(readScmDiffSummaryPublicationReceipt(output, { ...publication,
            updateNotice: { ...publication.updateNotice, revision: 3 } })).toBeNull();
    });
});
