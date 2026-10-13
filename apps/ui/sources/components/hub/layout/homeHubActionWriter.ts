import type { createActionExecutor } from '@happier-dev/protocol';
import { createHomeHubArtifactPortV1, HomeHubLayoutV1Schema, type HomeHubArtifactTransportV1, type HomeHubLayoutIntent } from '@happier-dev/protocol/home';
import { classifyWidgetDefinitionCommandResult } from '@/components/widgets/definitions/widgetDefinitionCommands';
import { resumeActionExecutionResult, type ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { HomeHubAcknowledgedProjectionReadError } from './homeHubAccountStore';

/** The mounted queue's Action adapter; the existing Artifact owner still commits every intent. */
export async function executeHomeHubLayoutIntent(input: Readonly<{
    intent: HomeHubLayoutIntent;
    scope: Readonly<{ serverId: string; accountId: string }>;
    transport: HomeHubArtifactTransportV1;
    execute: ReturnType<typeof createActionExecutor>['execute'];
    signal?: AbortSignal;
    onApprovalPending(registration: ActionApprovalContinuation): void;
}>) {
    const context = {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: input.scope.serverId, expectedAccountId: input.scope.accountId,
        signal: input.signal,
    } as const;
    const actionId = input.intent.kind === 'widget_size' ? 'widgets.item.size.set'
        : input.intent.kind === 'remove' ? 'widgets.item.remove' : 'home.hub.layout.update';
    const actionInput = input.intent.kind === 'widget_size' ? { ref: {
            surface: { ...input.scope, owner: { kind: 'home' } }, instanceId: input.intent.instanceId,
        }, size: input.intent.size } : input.intent.kind === 'remove' ? { ref: {
            surface: { ...input.scope, owner: { kind: 'home' } }, instanceId: input.intent.instanceId,
        } } : { intent: input.intent };
    const result = await resumeActionExecutionResult({
        result: await input.execute(actionId, actionInput, context), actionId, actionInput,
        scope: input.scope, signal: input.signal, onApprovalPending: input.onApprovalPending,
    });
    if (actionId === 'widgets.item.size.set' || actionId === 'widgets.item.remove') {
        const outcome = classifyWidgetDefinitionCommandResult(actionId, result);
        if (outcome.kind === 'refused') throw Object.assign(new Error(outcome.errorCode), { code: outcome.errorCode });
        // Universal mutation acknowledgement does not fabricate a native layout revision.
        try {
            return await createHomeHubArtifactPortV1(input.transport, { accountId: input.scope.accountId }).read();
        } catch (error) { throw new HomeHubAcknowledgedProjectionReadError(error); }
    }
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
    const value = result.result;
    if (!value || typeof value !== 'object' || !('layout' in value)) throw new Error('Home layout acknowledgement unavailable');
    return HomeHubLayoutV1Schema.parse(value.layout);
}
