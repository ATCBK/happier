import * as React from 'react';
import type { ExecutionRunStartRequest, ProviderBoundModelRef, TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol';
import type { ExecutionRunChildChoiceV1 } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { readExecutionRunChildChoice } from './executionRunChildChoice';

type StartInput = ExecutionRunStartRequest & Readonly<{ sessionId?: string | null }>;
type PendingChoice = Readonly<{ input: StartInput; choice: ExecutionRunChildChoiceV1 }>;

/** Retains a refused start only with host proof that no Run was created; an explicit choice starts a new attempt. */
export function useExecutionRunChildChoice(serverId: string) {
    const { execute, ready, isCurrent } = useMountedActionExecution(serverId);
    const [pending, setPending] = React.useState<PendingChoice | null>(null);
    const [error, setError] = React.useState<ActionExecuteResult | null>(null);
    const [starting, setStarting] = React.useState(false);
    const inFlight = React.useRef(false);
    React.useEffect(() => { setPending(null); setError(null); }, [execute]);
    const start = React.useCallback(async (input: StartInput) => {
        if (inFlight.current) return null;
        inFlight.current = true; setStarting(true); setError(null); setPending(null);
        try {
            const result = await execute('execution.run.start', input);
            if (!isCurrent()) return result;
            const choice = readExecutionRunChildChoice(result);
            setPending(choice ? { input, choice } : null);
            if (!result.ok && !choice) setError(result);
            return result;
        } finally { inFlight.current = false; setStarting(false); }
    }, [execute, isCurrent]);
    const choose = React.useCallback((selection: 'agentDefault' | ProviderBoundModelRef
        | Readonly<{ teamCredentialModel: TeamCredentialProviderModelSelectionV1 }>) => {
        if (!pending) return Promise.resolve(null);
        const { modelId: _modelId, modelSelection: _modelSelection, teamCredentialModel: _team,
            connectedServices: _connected, connectedServicesDefaultServiceIds: _defaults, childSelection: _child, ...input } = pending.input;
        return start(selection === 'agentDefault' ? { ...input, childSelection: 'agentDefault' }
            : 'teamCredentialModel' in selection ? { ...input, teamCredentialModel: selection.teamCredentialModel }
            : { ...input, modelSelection: selection });
    }, [pending, start]);
    const cancel = React.useCallback(() => { if (!inFlight.current) { setPending(null); setError(null); } }, []);
    return { start, choose, cancel, choice: pending?.choice ?? null, starting, error, ready };
}
