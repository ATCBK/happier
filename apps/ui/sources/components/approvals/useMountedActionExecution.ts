import * as React from 'react';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { resumeActionExecutionResult, type ActionApprovalContinuation } from './actionApprovalContinuation';
import { useActionApprovalContinuation } from './useActionApprovalContinuation';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createFrontDoorActionExecute, requireActionSuccess, type UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { SystemTaskRunner } from '@/components/systemTasks/types';

const onExecuted = () => {};
const retired = (): ActionExecuteResult => ({ ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });

/** Reconnect a mounted author's original public Action to its typed approval result. */
export function useMountedActionExecution(scopeOrHome: ServerAccountScope | string | null | undefined,
    options?: Readonly<{ onApprovalPending?: (registration: ActionApprovalContinuation) => void; openOnRequest?: boolean; runner?: SystemTaskRunner;
        /** Retain this mounted invocation's private operands/target across approval. */
        retainInvocation?: true;
        /** Existing local delivery ports; admission and approval presentation stay with this owner. */
        executorOptions?: Omit<NonNullable<Parameters<typeof createFrontDoorActionExecute>[1]>, 'onBlockingApprovalPending'>;
    }>) {
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
    // Dismissed surfaces can retire their interest before the modal finishes unmounting.
    const cancel = React.useCallback(() => lifetime.controller.abort(), [lifetime]);
    // Read at invocation because development effect replay can replace the controller.
    const getSignal = React.useCallback(() => lifetime.controller.signal, [lifetime]);
    const scopeKey = binding ? `${serverAccountScopeKeySuffix(binding.scope)}:${binding.revision}` : JSON.stringify(['unbound', scopeOrHome]);
    const approval = useActionApprovalContinuation({ scopeKey, serverId: scope?.serverId ?? '', onExecuted,
        openOnRequest: options?.openOnRequest });
    const frontDoorOptions = React.useMemo(() => ({
        ...options?.executorOptions,
        homeRuntimeRunner: options?.runner ?? options?.executorOptions?.homeRuntimeRunner,
        onBlockingApprovalPending: ({ artifactId, signal }: Readonly<{ artifactId: string; signal?: AbortSignal }>) => {
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
    }), [approval.requestApproval, binding, isCurrent, lifetime, options?.executorOptions, options?.onApprovalPending, options?.runner]);
    const frontDoor = React.useMemo(() => createFrontDoorActionExecute(undefined, frontDoorOptions), [frontDoorOptions]);
    const execute = React.useCallback(async (actionId: ActionId, input: unknown,
        operation?: UiActionOperation & Readonly<{ retainInvocation?: true }>): Promise<ActionExecuteResult> => {
        if (!binding || !scope || !isCurrent()) return retired();
        const cancellation = mergeAbortSignals([lifetime.controller.signal, operation?.signal]);
        try {
        // The admitted input includes the draft's original CAS. Never recapture it after approval.
        // Await the initial operation directly: later retirement cannot retract a durable ACK.
        const invoke = (operation?.retainInvocation ?? options?.retainInvocation)
            ? createFrontDoorActionExecute(undefined, { ...frontDoorOptions,
                hostActionApprovalLifetime: { actionId, signal: cancellation.signal, surface: 'ui' },
            }) : frontDoor;
        const result = await invoke(actionId, input, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: scope.serverId, expectedAccountId: scope.accountId,
            signal: cancellation.signal,
            ...(operation?.defaultSessionId ? { defaultSessionId: operation.defaultSessionId } : {}),
            ...(operation?.actionRequestId ? { actionRequestId: operation.actionRequestId } : {}),
            ...(operation?.onTransportIssued ? { onTransportIssued: operation.onTransportIssued } : {}),
            ...(operation?.isPluginSettingsIntentCurrent ? { isPluginSettingsIntentCurrent: operation.isPluginSettingsIntentCurrent } : {}),
            ...(operation?.presentUserConfirmation ? { presentUserConfirmation: operation.presentUserConfirmation } : {}),
            ...(operation?.executionRunTargetMachineId ? { executionRunTargetMachineId: operation.executionRunTargetMachineId } : {}),
            ...(operation?.executionRunLaunchOrigin ? { executionRunLaunchOrigin: operation.executionRunLaunchOrigin } : {}),
            ...(operation?.externalActionTarget ? { externalActionTarget: operation.externalActionTarget } : {}),
            ...(operation?.openRoute ? { openRoute: operation.openRoute } : {}),
            ...(operation?.reviewPublicProfilePreparedAction ? { reviewPublicProfilePreparedAction: operation.reviewPublicProfilePreparedAction } : {}),
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
        } catch (error) {
            if (!isCurrent()) return retired();
            throw error;
        } finally { cancellation.dispose(); }
    }, [approval.requestApproval, binding, frontDoor, frontDoorOptions, isCurrent, lifetime, options?.onApprovalPending, options?.retainInvocation, scope]);
    /** Value-parsing clients unwrap only the terminal receipt delivered by this same mounted owner. */
    const executeValue = React.useCallback(async (actionId: ActionId, input: unknown, operation?: UiActionOperation): Promise<unknown> => {
        const result = await execute(actionId, input, operation);
        requireActionSuccess(result);
        return result.result;
    }, [execute]);
    return { execute, executeValue, ready: isCurrent(), isCurrent, cancel, getSignal, approval, binding, resolution };
}
