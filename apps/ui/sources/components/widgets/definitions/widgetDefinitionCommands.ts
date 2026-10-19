import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec, type PublicActionInputById, type PublicActionResultById } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

import { randomUUID } from '@/platform/randomUUID';

/**
 * The definition, promotion and snapshot screens call the canonical `widgets.*` Actions — the very
 * operations an agent uses — and read back one of three facts: it happened (with the parsed result),
 * it is waiting for approval in the Inbox, or it was refused with a code. No screen writes an
 * Artifact or a Board item itself.
 */
export type WidgetDefinitionCommandOutcome<Result> =
    | Readonly<{ kind: 'applied'; result: Result }>
    | Readonly<{ kind: 'approvalPending' }>
    | Readonly<{ kind: 'refused'; errorCode: string }>;

type CommandId = Extract<ActionId,
    | 'widgets.fragment.list'
    | 'widgets.fragment.get'
    | 'widgets.fragment.create'
    | 'widgets.fragment.update'
    | 'widgets.fragment.duplicate'
    | 'widgets.fragment.delete'
    | 'widgets.group.add'
    | 'widgets.definition.get'
    | 'widgets.definition.list'
    | 'widgets.definition.duplicate'
    | 'widgets.definition.saveFromSession'
    | 'widgets.item.add'
    | 'widgets.item.remove'
    | 'widgets.item.size.set'
    | 'widgets.item.refresh'
    | 'widgets.snapshot.post'>;

/** The exact Home and Account the person is acting in; a call never drifts to another. */
export type WidgetCommandTarget = Readonly<{ serverId: string; accountId: string }>;

/** All widget Action adapters distinguish a committed result from approval custody. */
export function classifyWidgetDefinitionCommandResult<Id extends CommandId>(
    actionId: Id,
    result: ActionExecuteResult,
): WidgetDefinitionCommandOutcome<PublicActionResultById[Id]> {
    if (!result.ok) return { kind: 'refused', errorCode: result.errorCode ?? 'widget_command_failed' };
    if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) return { kind: 'approvalPending' };
    const parsed = getActionSpec(actionId).outputSchema?.safeParse(result.result);
    if (!parsed?.success) return { kind: 'refused', errorCode: 'invalid_action_output' };
    return { kind: 'applied', result: parsed.data as PublicActionResultById[Id] };
}

export async function runWidgetDefinitionCommand<Id extends CommandId>(
    actionId: Id,
    input: PublicActionInputById[Id] | (() => PublicActionInputById[Id]),
    target: WidgetCommandTarget,
    signal?: AbortSignal,
    widgetAreaContext?: ActionExecutorContext['widgetAreaContext'],
    /**
     * The screen itself was the person's confirmation of this exact Action (a preview they read and
     * pressed). It satisfies the policy's default UI confirmation once, so no second dialog follows; an
     * approval configured in Settings → Actions still applies, and agents never carry it.
     */
    confirmation?: ActionExecutorContext['presentUserConfirmation'],
): Promise<WidgetDefinitionCommandOutcome<PublicActionResultById[Id]>> {
    try {
        // Preparing widget inputs can fail at the platform or validation boundary too.
        const preparedInput = typeof input === 'function' ? input() : input;
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        // The person pressed it: present-user authority, one request id, so a consequential
        // operation enters the existing approval policy exactly as any other UI Action does.
        const result = await createDefaultActionExecutor().execute(actionId, preparedInput, {
            surface: 'ui', authority: 'present_user', serverId: target.serverId, expectedAccountId: target.accountId,
            actionRequestId: randomUUID(), ...(signal ? { signal } : {}),
            ...(widgetAreaContext ? { widgetAreaContext } : {}),
            ...(confirmation ? { presentUserConfirmation: confirmation } : {}),
        });
        return classifyWidgetDefinitionCommandResult(actionId, result);
    } catch (error) {
        if (signal?.aborted) return { kind: 'refused', errorCode: 'cancelled' };
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'widget_command_failed';
        return { kind: 'refused', errorCode: code };
    }
}
