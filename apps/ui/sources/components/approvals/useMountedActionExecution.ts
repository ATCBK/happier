import * as React from 'react';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { resumeActionExecutionResult, type ActionApprovalContinuation } from './actionApprovalContinuation';
import { useActionApprovalContinuation } from './useActionApprovalContinuation';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createFrontDoorActionExecute, type UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { SystemTaskRunner } from '@/components/systemTasks/types';

const onExecuted = () => {};
const retired = (): ActionExecuteResult => ({ ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });

/** Reconnect a mounted author's original public Action to its typed approval result. */
export function useMountedActionExecution(scopeOrHome: ServerAccountScope | string | null | undefined,
    options?: Readonly<{ onApprovalPending?: (registration: ActionApprovalContinuation) => void; openOnRequest?: boolean; runner?: SystemTaskRunner }>) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(typeof scopeOrHome === 'string' ? scopeOrHome : scopeOrHome?.serverId ?? null);
    const scope = typeof scopeOrHome === 'string' ? binding?.scope : scopeOrHome;
    const lifetime = React.useMemo(() => ({ controller: new AbortController() }), [binding]);
    React.useEffect(() => {
        // Development effect replay restores interest only while the original binding is current.
        if (lifetime.controller.signal.aborted) lifetime.controller = new AbortController();
        const controller = lifetime.controller;
        const retirement = binding?.onRetire(() => controller.abort());
        return () => { retirement?.dispose(); controller.abort(); };
    }, [binding, lifetime]);
    const isCurrent = React.useCallback(() => Boolean(binding?.isCurrent()
        && areServerAccountScopesEqual(binding.scope, scope) && !lifetime.controller.signal.aborted), [binding, lifetime, scope]);
    const scopeKey = binding ? `${serverAccountScopeKeySuffix(binding.scope)}:${binding.revision}` : JSON.stringify(['unbound', scopeOrHome]);
    const approval = useActionApprovalContinuation({ scopeKey, serverId: scope?.serverId ?? '', onExecuted,
        openOnRequest: options?.openOnRequest });
    const frontDoor = React.useMemo(() => createFrontDoorActionExecute(undefined, {
        homeRuntimeRunner: options?.runner,
        onBlockingApprovalPending: ({ artifactId, signal }) => {
            if (!binding || !isCurrent()) return;
            // Blocking Actions retain their live input and result in the executor.
            // This registration only presents that same Artifact while it waits;
            // it never replays the effect or consumes a second result continuation.
            const registration: ActionApprovalContinuation = {
                artifactId, scope: binding.scope, refreshAfterExecution: false,
                signal: signal ?? lifetime.controller.signal,
                onExecuted: async () => 'ignored',
            };
            approval.requestApproval(registration);
            options?.onApprovalPending?.(registration);
        },
    }), [approval.requestApproval, binding, isCurrent, lifetime, options?.onApprovalPending, options?.runner]);
    const execute = React.useCallback(async (actionId: ActionId, input: unknown,
        operation?: UiActionOperation): Promise<ActionExecuteResult> => {
        if (!binding || !scope || !isCurrent()) return retired();
        const cancellation = mergeAbortSignals([lifetime.controller.signal, operation?.signal]);
        try {
        // The admitted input includes the draft's original CAS. Never recapture it after approval.
        // Await the initial operation directly: later retirement cannot retract a durable ACK.
        const result = await frontDoor(actionId, input, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: scope.serverId, expectedAccountId: scope.accountId,
            signal: cancellation.signal,
            ...(operation?.defaultSessionId ? { defaultSessionId: operation.defaultSessionId } : {}),
            ...(operation?.actionRequestId ? { actionRequestId: operation.actionRequestId } : {}),
            ...(operation?.onTransportIssued ? { onTransportIssued: operation.onTransportIssued } : {}),
            ...(operation?.presentUserConfirmation ? { presentUserConfirmation: operation.presentUserConfirmation } : {}),
        });
        if (!result.ok) return result;
        const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (!pending.success) return result;
        if (!isCurrent()) return retired();
        return await resumeActionExecutionResult({ result, actionId, actionInput: input, scope: binding.scope,
            signal: cancellation.signal, ...(operation?.actionRequestId ? { requestId: operation.actionRequestId } : {}),
            onApprovalPending: registration => {
                approval.requestApproval(registration);
                options?.onApprovalPending?.(registration);
            },
        });
        } finally { cancellation.dispose(); }
    }, [approval.requestApproval, binding, frontDoor, isCurrent, lifetime, options?.onApprovalPending, scope]);
    return { execute, ready: isCurrent(), isCurrent, approval, binding, resolution };
}
