import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { EMPTY_WORKFLOW_ATTENTION_SOURCE } from '@/hooks/inbox/useWorkflowAttentionSource';

/** Complete attention inputs shared by Inbox presentation fixtures. */
export function createInboxAttentionFixture(serverId: string | null = null): Pick<InboxModel, 'workflowAttention' | 'automationAttention' | 'automationAttentionItems'
    | 'items' | 'sessionCandidates' | 'accountNotices' | 'openAccountNotices' | 'dismissAccountNotice' | 'markItemOpened' | 'discussionAttention'> {
    return {
        workflowAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, serverId, runIds: [] },
        automationAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, serverId, runIds: [] },
        automationAttentionItems: [],
        items: [], sessionCandidates: [], accountNotices: [], openAccountNotices: [], dismissAccountNotice: async () => {}, markItemOpened: async () => {},
        discussionAttention: { source: null, coverage: 'unavailable', available: false, loading: false,
            status: 'idle', errorCode: null, markOpened: async () => {}, refresh: () => undefined, loadMore: () => undefined },
    };
}
