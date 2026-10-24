import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ScmDiffSummaryGenerateOutputSchema, type ScmDiffSummaryGenerateOutput } from '@happier-dev/protocol/scm/diffSummary';
import { ScmDiffSummaryPublicationReceiptSchema, type ScmDiffSummaryPublicationReceipt } from '@happier-dev/protocol/scm/diffSummaryResult';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import { HappierMetaEnvelopeSchema } from '@happier-dev/protocol/messages/structured/HappierMetaEnvelope';

export type ScmDiffSummaryPublishedResult = Readonly<{
    output: Extract<ScmDiffSummaryGenerateOutput, { success: true }> & { resultId: string; revision: number; comparison: ScmComparison };
    publication: ScmDiffSummaryPublicationReceipt;
}>;

/** Only a saved publication is a receipt; baseline metadata and discussion remain ordinary messages. */
export function readScmDiffSummaryPublicationReceipt(meta: unknown): ScmDiffSummaryPublishedResult | null {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const publication = ScmDiffSummaryPublicationReceiptSchema.safeParse(Reflect.get(meta, 'scmResultUpdate'));
    if (!publication.success) return null;
    const envelope = createStoredReadSchema(HappierMetaEnvelopeSchema).safeParse(Reflect.get(meta, 'happier'));
    if (!envelope.success || envelope.data.kind !== 'scm_diff_summary.v1') return null;
    const output = createStoredReadSchema(ScmDiffSummaryGenerateOutputSchema).safeParse(envelope.data.payload);
    if (!output.success || !output.data.success || !output.data.resultId || output.data.revision === undefined || !output.data.comparison
        || (publication.data.updateNotice && publication.data.updateNotice.revision !== output.data.revision)
        || publication.data.outputs.some(({ kind }) => output.data.outputs?.[kind]?.value === undefined)) return null;
    return { output: { ...output.data, resultId: output.data.resultId, revision: output.data.revision, comparison: output.data.comparison },
        publication: publication.data };
}
