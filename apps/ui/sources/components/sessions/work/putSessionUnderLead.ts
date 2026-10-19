import { Modal } from '@/modal';
import { getStorage } from '@/sync/domains/state/storage';
import { setSessionManager } from '@/sync/ops/relations/setSessionManager';
import { loadSessionManagerEligibility } from '@/sync/ops/relations/sessionManagerEligibility';
import { t } from '@/text';

import { resolvePutUnderEligibility } from './putUnderCandidates';
import { selectSessionRelationRecords } from './reportSubtree';
import { describeManagerRefusal, isManagerRefusal } from './putUnderPresentation';
export { describeManagerRefusal } from './putUnderPresentation';

export type PutSessionUnderLeadResult = 'applied' | 'not-eligible' | 'refused' | 'unknown';

/**
 * The Sessions-list drop "put this Session under that one" (R-03). Re-checks the drop against the
 * latest store (the list kept moving while the person dragged), sends the one
 * `session.manager.set` Action with the Home read's lead as the expected current lead,
 * and says a refusal in words. The server's fence and compare-and-set decide.
 */
export async function putSessionUnderLead(input: Readonly<{
    serverId: string | null;
    sessionId: string;
    managerSessionId: string;
    signal?: AbortSignal;
    accountId?: string;
}>): Promise<PutSessionUnderLeadResult> {
    const initialState = getStorage().getState();
    const initialSessions = selectSessionRelationRecords(initialState.sessions, input.serverId, initialState.sessionListRowsByServerId);
    if (!input.serverId || !initialSessions[input.sessionId] || !initialSessions[input.managerSessionId]) return 'not-eligible';
    const facts = await loadSessionManagerEligibility({
        serverId: input.serverId, sessionId: input.sessionId, candidateSessionIds: [input.managerSessionId], signal: input.signal,
    });
    const state = getStorage().getState();
    const sessions = selectSessionRelationRecords(state.sessions, input.serverId, state.sessionListRowsByServerId);
    const eligibility = resolvePutUnderEligibility(sessions, input.sessionId, input.managerSessionId, facts, {
        serverId: input.serverId, ...(input.accountId ? { accountId: input.accountId } : {}),
    });
    if (!eligibility.allowed) {
        facts?.dispose();
        return 'not-eligible';
    }
    let errorCode: string | undefined;
    try {
        const result = await setSessionManager({
            sessionId: input.sessionId,
            managerSessionId: input.managerSessionId,
            expectedManagerSessionId: eligibility.expectedManagerSessionId,
            serverId: input.serverId,
            signal: input.signal,
            expectedAccountId: facts?.accountId,
        });
        if (result.ok) return 'applied';
        errorCode = result.errorCode;
    } catch {
        errorCode = undefined;
    } finally {
        facts?.dispose();
    }
    // A lost response or malformed/transport failure cannot prove that no edge was written.
    if (!isManagerRefusal(errorCode)) return 'unknown';
    Modal.alert(t('sessionWork.putUnder.title'), describeManagerRefusal(errorCode));
    return 'refused';
}
