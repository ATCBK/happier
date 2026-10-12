import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { EMPTY_WORKFLOW_ATTENTION_SOURCE } from '@/hooks/inbox/useWorkflowAttentionSource';

/** Complete attention inputs shared by Inbox presentation fixtures. */
export function createInboxAttentionFixture(serverId: string | null = null): Pick<InboxModel, 'workflowAttention' | 'automationAttention' | 'automationAttentionItems'> {
    return {
        workflowAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, serverId, runIds: [] },
        automationAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, serverId, runIds: [] },
        automationAttentionItems: [],
    };
}
