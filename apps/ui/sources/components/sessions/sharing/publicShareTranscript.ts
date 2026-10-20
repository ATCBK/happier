import { createReducer, reducer, type ReducerState } from '@happier-dev/session-core/reducer';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import type { AgentState } from '@happier-dev/session-core/state';
import type { Message } from '@happier-dev/session-core/messages';
import { sortNormalizedMessagesOldestFirst } from '@/utils/sessions/sortNormalizedMessagesOldestFirst';
import type { Metadata } from '@happier-dev/session-core/state';
import { readSharedMetadataPresentationCompletedRequests } from '@happier-dev/session-core/pending';

export function createPublicSharePresentationAgentState(
    metadata: Metadata | null,
    metadataLayoutVersion: unknown,
): AgentState {
    return {
        completedRequests: readSharedMetadataPresentationCompletedRequests(
            metadata,
            metadataLayoutVersion,
        ),
    } as AgentState;
}

export function reducePublicShareTranscript(
    normalized: readonly NormalizedMessage[],
    agentState: AgentState,
    mainHistoryStartLoaded = false,
): Readonly<{ messages: Message[]; reducerState: ReducerState }> {
    // Reduction is not incremental here: an older page lands BEFORE rows the reducer has
    // already folded, so the whole accepted set is reduced again from a fresh state.
    const ordered = [...normalized];
    sortNormalizedMessagesOldestFirst(ordered);
    const reducerState = createReducer();
    const messages = reducer(reducerState, ordered, agentState, [], { mainHistoryStartLoaded }).messages;
    return { messages, reducerState };
}

