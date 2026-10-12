import type { WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';
import type { WorkflowCondition } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { listWorkflowProducerOptions } from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

/**
 * Notify me's "Only if the agent reported something" (PLAN D7): an offer over the step's own
 * `onlyWhen`, which stays the one semantic owner. The offer holds no state of its own; it reads
 * and edits conjuncts of that condition.
 *
 * "The agent reported something" is a condition on an earlier Agent step's result that says the
 * agent had something to report: its text is not empty, or one of its named results is Yes. Both
 * shapes are what an author (or the offer) writes for this intent, so the offer reads ON for
 * either, and turning it off removes exactly those conjuncts.
 */

export type WorkflowNotifyReportOffer = Readonly<{
    /** Whether the condition already says the agent reported something. */
    on: boolean;
    /**
     * The condition the offer adds when turned on: the message's own Agent text result is not
     * empty. `null` when the message is not an earlier Agent step's text result.
     */
    canonical: WorkflowCondition | null;
    /** Whether the offer can change anything (turn on through `canonical`, or turn off). */
    available: boolean;
}>;

export const WORKFLOW_NOTIFY_ME_ACTION_ID = 'notifications.notify_me';

function isEarlierAgentResult(draft: WorkflowEditorDraft, consumerBlockId: string, value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const reference = value as { kind?: unknown; producer?: { blockId?: unknown; scope?: unknown } };
    if (reference.kind !== 'result' || typeof reference.producer?.blockId !== 'string') return false;
    const producerId = reference.producer.blockId;
    if (findWorkflowBlock(draft, producerId)?.kind !== 'step') return false;
    return listWorkflowProducerOptions(draft, consumerBlockId).some(option => (
        !option.isBranch && option.blockId === producerId && sameStrictJsonValue(option.scope, reference.producer?.scope)
    ));
}

/** One conjunct that says an earlier Agent step reported something. */
function isReportConjunct(draft: WorkflowEditorDraft, consumerBlockId: string, part: WorkflowCondition): boolean {
    if (part.kind !== 'compare' || part.right.kind !== 'literal') return false;
    if (!isEarlierAgentResult(draft, consumerBlockId, part.left)) return false;
    return (part.operator === 'neq' && part.right.value === '') || (part.operator === 'eq' && part.right.value === true);
}

function conjuncts(condition: WorkflowCondition | undefined): readonly WorkflowCondition[] {
    if (condition === undefined) return [];
    return condition.kind === 'all' ? condition.conditions : [condition];
}

/** The exact text result uses '' for a completed Agent turn with no final text. */
function canonicalReportCondition(draft: WorkflowEditorDraft, block: WorkflowActionLeafV1): WorkflowCondition | null {
    const message = block.input.message;
    if (message?.kind !== 'result' || message.path.length !== 0) return null;
    const source = findWorkflowBlock(draft, message.producer.blockId);
    if (source?.kind !== 'step' || source.result.kind !== 'text') return null;
    if (!isEarlierAgentResult(draft, block.id, message)) return null;
    return { kind: 'compare', operator: 'neq', left: message, right: { kind: 'literal', value: '' } };
}

export function readWorkflowNotifyReportOffer(draft: WorkflowEditorDraft, block: WorkflowActionLeafV1): WorkflowNotifyReportOffer {
    const canonical = canonicalReportCondition(draft, block);
    const on = conjuncts(block.onlyWhen).some(part => isReportConjunct(draft, block.id, part));
    return { on, canonical, available: on || canonical !== null };
}

/**
 * The block's next `onlyWhen` with the offer set. Only the report conjuncts change; every
 * independently authored conjunct keeps its exact shape.
 */
export function setWorkflowNotifyReportOffer(draft: WorkflowEditorDraft, block: WorkflowActionLeafV1, enabled: boolean): WorkflowCondition | undefined {
    const condition = block.onlyWhen;
    const offer = readWorkflowNotifyReportOffer(draft, block);
    if (enabled) {
        if (offer.on || offer.canonical === null) return condition;
        return condition === undefined ? offer.canonical : { kind: 'all', conditions: [condition, offer.canonical] };
    }
    if (condition === undefined) return undefined;
    if (condition.kind !== 'all') return isReportConjunct(draft, block.id, condition) ? undefined : condition;
    const remaining = condition.conditions.filter(part => !isReportConjunct(draft, block.id, part));
    return remaining.length === condition.conditions.length ? condition
        : remaining.length === 0 ? undefined : remaining.length === 1 ? remaining[0] : { ...condition, conditions: remaining };
}
