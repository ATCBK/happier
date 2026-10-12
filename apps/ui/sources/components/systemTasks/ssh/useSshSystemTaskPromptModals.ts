import * as React from 'react';

import type { SystemTaskRunState, SystemTaskRunner } from '../types';
import type { SystemTaskPromptEnvelope } from '../prompts/readLatestSystemTaskPrompt';
import { createSshSystemTaskPromptContinuation } from './answerSshSystemTaskPrompt';

export function useSshSystemTaskPromptModals(params: Readonly<{
    runner: SystemTaskRunner;
    taskId: string | null;
    snapshot: SystemTaskRunState | null;
    prompt: SystemTaskPromptEnvelope | null;
}>): void {
    React.useEffect(() => {
        const taskId = params.taskId;
        if (!taskId || params.snapshot?.result) return;
        // Keep admitted domain authority while retrying its current prompt on remount.
        // The runner owns selection, replay dedupe and task-lifetime retention.
        params.runner.registerPromptContinuation?.(taskId, createSshSystemTaskPromptContinuation(params.runner, taskId), {
            preserveExisting: true,
        });
    }, [params.runner, params.snapshot?.result, params.taskId]);
}
