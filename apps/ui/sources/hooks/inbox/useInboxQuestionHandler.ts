import { useSessionAwareness } from '@/sync/domains/session/awareness/useSessionAwareness';
import type { InboxItem } from '@/components/inbox/inboxItems';

/** Row-local manager facts; request ownership, handler selection and answer authority stay unchanged. */
export function useInboxQuestionHandler(question: InboxItem['question']) {
    const address = question?.currentHandler.kind === 'session' ? question.currentHandler.address : null;
    const { session, awareness } = useSessionAwareness(address?.sessionId ?? '', address?.serverId ?? null);
    return { question, address, session, awareness };
}
