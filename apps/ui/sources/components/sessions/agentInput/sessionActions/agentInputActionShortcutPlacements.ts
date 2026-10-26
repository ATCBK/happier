import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

import type { AgentInputControlPlacement, AgentInputPlacementContext } from '../controls/agentInputControlTypes';

export type AgentInputActionShortcutContext = 'session' | 'newSession';

export function getAgentInputActionShortcutKey(context: AgentInputActionShortcutContext, actionId: ActionId): string {
    return `${context === 'session' ? 'session-action' : 'new-session-action'}:${actionId}`;
}

export function getAgentInputActionShortcutPlacement(params: Readonly<{ key: string; label: string }>): AgentInputControlPlacement {
    return { id: `shortcuts:${params.key}`, title: params.label, icon: 'lightning', defaultPlacement: 'overflow' };
}

export function getAgentInputActionShortcutDefinition(context: AgentInputActionShortcutContext, actionId: ActionId): Readonly<{ key: string; label: string }> {
    return { key: getAgentInputActionShortcutKey(context, actionId), label: getActionSpec(actionId).title };
}

export function buildConfiguredActionShortcutPlacementDefinitions(actionIds: readonly ActionId[]): readonly Readonly<{
    controlId: 'shortcuts';
    placement: AgentInputControlPlacement;
    contexts: readonly AgentInputPlacementContext[];
}>[] {
    return actionIds.flatMap(actionId => (['session', 'newSession'] as const).map(context => ({
        controlId: 'shortcuts' as const,
        contexts: [context],
        placement: getAgentInputActionShortcutPlacement(getAgentInputActionShortcutDefinition(context, actionId)),
    })));
}
