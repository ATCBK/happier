import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';

/**
 * A consented request's follow-up write belongs to its Home/Account, not the view
 * answering it. The Action front door still owns credentials, policy and CAS;
 * removing the attention card cannot retire this execution.
 */
export function createRequestOwnedActionExecution(scope: ServerAccountScope | null) {
    const execute = scope ? scopedHomeActionExecutor(scope) : null;
    return (actionId: ActionId, input: unknown): Promise<ActionExecuteResult> => execute && scope
        ? execute(actionId, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: scope.serverId, expectedAccountId: scope.accountId })
        : Promise.resolve({ ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });
}
