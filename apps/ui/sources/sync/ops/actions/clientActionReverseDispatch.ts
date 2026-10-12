import {
    UiActionDispatchRequestV1Schema,
    parseClientActionDispatchResult,
} from '@happier-dev/protocol/actions/clientDispatchV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { projectKnownAccountAuthorityRetirementReceipt } from '@happier-dev/protocol/actions/accountAuthorityRetirement';
import { createDefaultActionExecutor } from './defaultActionExecutor';

/** Only the server-authenticated exact Machine may enter this admitted continuation. */
export function createUiClientActionReverseHandler(binding: Readonly<{
    serverId: string;
    accountId: string;
    isCurrent(): boolean;
}>) {
    const failure = (errorCode: string) => ({ v: 1 as const, execution: { ok: false as const, errorCode, error: errorCode } });
    return async (raw: unknown, context?: Readonly<{ signal: AbortSignal }>) => {
        const request = UiActionDispatchRequestV1Schema.safeParse(raw);
        if (!request.success) return failure('invalid_action_input');
        if (!binding.isCurrent() || !context || context.signal.aborted) return failure('target_unavailable');
        const { actionId, input, context: admitted } = request.data;
        const executor = createDefaultActionExecutor({ admittedClientActionId: actionId });
        try {
            const execution = await executor.execute(actionId, input, {
                ...admitted,
                serverId: binding.serverId,
                expectedAccountId: binding.accountId,
                signal: context.signal,
            });
            // Retirement cannot disclose the old Account's data. Only a declared,
            // validated self-retirement keeps its already-known status-only receipt.
            let safeExecution = execution;
            if (!binding.isCurrent()) {
                const receipt = projectKnownAccountAuthorityRetirementReceipt(getActionSpec(actionId), execution);
                if (!receipt) return failure('outcome_uncertain');
                safeExecution = receipt;
            }
            const result = parseClientActionDispatchResult(actionId, { v: 1, execution: safeExecution });
            return result ? { v: 1 as const, execution: result } : failure('invalid_action_output');
        } catch {
            return failure('outcome_uncertain');
        }
    };
}
