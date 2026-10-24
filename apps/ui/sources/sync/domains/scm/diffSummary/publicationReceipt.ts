import type { ScmDiffSummaryGenerateOutput } from '@happier-dev/protocol/scm/diffSummary';
import { ScmDiffSummaryPublicationReceiptSchema, type ScmDiffSummaryPublicationReceipt } from '@happier-dev/protocol/scm/diffSummaryResult';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';

export type ScmDiffSummaryPublishedResult = Readonly<{
    output: Extract<ScmDiffSummaryGenerateOutput, { success: true }> & { resultId: string; revision: number; comparison: ScmComparison };
    publication: ScmDiffSummaryPublicationReceipt;
}>;

/** Structured-message admission already checked the output; only its separate carrier is untrusted here. */
export function readScmDiffSummaryPublicationReceipt(
    output: ScmDiffSummaryGenerateOutput,
    publicationCarrier: unknown,
): ScmDiffSummaryPublishedResult | null {
    const publication = ScmDiffSummaryPublicationReceiptSchema.safeParse(publicationCarrier);
    if (!publication.success) return null;
    if (!output.success || !output.resultId || output.revision === undefined || !output.comparison
        || (publication.data.updateNotice && publication.data.updateNotice.revision !== output.revision)
        || publication.data.outputs.some(({ kind }) => output.outputs?.[kind]?.value === undefined)) return null;
    return { output: { ...output, resultId: output.resultId, revision: output.revision, comparison: output.comparison },
        publication: publication.data };
}
