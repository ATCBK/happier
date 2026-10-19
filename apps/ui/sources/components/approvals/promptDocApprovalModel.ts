import type { ApprovalRequest } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

export type PromptDocUpdateApproval = Readonly<{
    artifactId: string;
    title: string;
    markdown: string;
    expectedRevision: Readonly<{ headerVersion: number; bodyVersion: number }> | null;
}>;

/** The edit reviewed by the existing diff surface, through the Action's input schema. */
export function readPromptDocUpdateApproval(approval: ApprovalRequest): PromptDocUpdateApproval | null {
    if (approval.actionId !== 'prompt_doc.update') return null;
    const parsed = getActionSpec('prompt_doc.update').inputSchema.safeParse(approval.actionArgs);
    if (!parsed.success) return null;
    const input = parsed.data as Readonly<{ artifactId: string; title: string; markdown: string;
        expectedRevision?: Readonly<{ headerVersion: number; bodyVersion: number }> }>;
    return { artifactId: input.artifactId, title: input.title, markdown: input.markdown,
        expectedRevision: input.expectedRevision ?? null };
}
