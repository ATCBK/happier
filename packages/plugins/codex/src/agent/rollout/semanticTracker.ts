import type { CodexRolloutAction } from './projection/actions.js';

type NormalizedCodexRolloutAction = Exclude<
    CodexRolloutAction,
    { type: 'collaboration-tool-call' } | { type: 'collaboration-tool-result' }
>;

export type CodexRolloutSemanticState = Readonly<{
    pendingSpawnByCallId: readonly (readonly [string, Readonly<{
        prompt: string | null;
        nickname: string | null;
        role: string | null;
    }>])[];
    startedThreadIds: readonly string[];
    completedThreadIds: readonly string[];
    lastEmittedAssistantText: string | null;
}>;

export function createCodexRolloutSemanticTracker(state?: CodexRolloutSemanticState) {
    const pendingSpawnByCallId = new Map(state?.pendingSpawnByCallId);
    const startedThreadIds = new Set(state?.startedThreadIds);
    const completedThreadIds = new Set(state?.completedThreadIds);
    /**
     * Pre-frontier Codex recorders write one assistant turn twice: first as
     * `event_msg`/`agent_message`, then as the `response_item` message the model
     * API returned, with nothing publishable in between. The pinned recorder
     * writes only the first. Keeping the last emitted assistant text lets both
     * eras publish the turn exactly once without the reader needing to know
     * which recorder produced the file.
     */
    let lastEmittedAssistantText = state?.lastEmittedAssistantText ?? null;

    return {
        breakAssistantEcho(): void {
            lastEmittedAssistantText = null;
        },
        snapshot(): CodexRolloutSemanticState {
            return { pendingSpawnByCallId: [...pendingSpawnByCallId], startedThreadIds: [...startedThreadIds],
                completedThreadIds: [...completedThreadIds], lastEmittedAssistantText };
        },
        consume(action: CodexRolloutAction): NormalizedCodexRolloutAction[] {
            if (action.type === 'assistant-text') {
                if (action.text === lastEmittedAssistantText) return [];
                lastEmittedAssistantText = action.text;
                return [action];
            }
            if (action.type !== 'debug') lastEmittedAssistantText = null;

            if (action.type === 'collaboration-tool-call') {
                if (action.name === 'spawn_agent') {
                    pendingSpawnByCallId.set(action.callId, {
                        prompt: action.prompt,
                        nickname: action.nickname,
                        role: action.role,
                    });
                }
                return [];
            }

            if (action.type === 'collaboration-tool-result') {
                const pendingSpawn = pendingSpawnByCallId.get(action.callId);
                pendingSpawnByCallId.delete(action.callId);
                if (!action.threadId) return [];
                if (startedThreadIds.has(action.threadId)) return [];

                startedThreadIds.add(action.threadId);
                return [{
                    type: 'subagent-spawn',
                    threadId: action.threadId,
                    prompt: pendingSpawn?.prompt ?? null,
                    nickname: action.nickname ?? pendingSpawn?.nickname ?? null,
                    role: pendingSpawn?.role ?? null,
                }];
            }

            if (action.type === 'subagent-spawn') {
                if (startedThreadIds.has(action.threadId)) return [];
                startedThreadIds.add(action.threadId);
                return [action];
            }

            if (action.type === 'subagent-complete') {
                if (completedThreadIds.has(action.threadId)) return [];
                completedThreadIds.add(action.threadId);

                if (!startedThreadIds.has(action.threadId)) {
                    startedThreadIds.add(action.threadId);
                    return [
                        {
                            type: 'subagent-spawn',
                            threadId: action.threadId,
                            prompt: null,
                            nickname: null,
                            role: null,
                        },
                        action,
                    ];
                }

                return [action];
            }

            return [action];
        },
    };
}
