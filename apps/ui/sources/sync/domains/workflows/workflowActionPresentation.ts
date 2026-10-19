import type { ActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { t } from '@/text';
export { resolveActionTitle as resolveWorkflowActionTitle } from '@/text/actionTitles';

/** Human outcomes for picker descriptions; the protocol retains its agent-facing contract. */
export function resolveWorkflowActionDescription(actionId: string, spec: Pick<ActionSpec, 'description'>): string | undefined {
    if (actionId === 'wait') return t('workflows.actionTitles.waitForWorkDescription');
    if (actionId === 'webhooks.call') return t('workflows.actionTitles.callWebhookDescription');
    if (actionId === 'machines.command.run') return t('workflows.actionTitles.runCommandDescription');
    return spec.description;
}
