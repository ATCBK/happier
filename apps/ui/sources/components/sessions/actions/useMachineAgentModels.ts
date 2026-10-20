import * as React from 'react';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { useActionFieldOptionsForMachine } from './useSessionActionFieldOptions';

export type MachineAgentModel = Readonly<{
    id: string;
    name: string;
    description?: string | null;
}>;

const SPAWN_MODEL_FIELD = (() => {
    const field = getActionSpec('session.spawn_new').inputHints?.fields
        .find((candidate) => candidate.path === 'modelSelection');
    if (!field) throw new Error('session.spawn_new modelSelection field is missing');
    return field;
})();

/** Native Agent models from Session spawn's canonical machine-specific Action option source. */
export function useMachineAgentModels(input: Readonly<{
    agentTargetKey: string;
    machineId: string | null;
    serverId: string | null;
    enabled: boolean;
}>): readonly MachineAgentModel[] | null {
    const agentTarget = React.useMemo(() => {
        try {
            const parsed = parseBackendTargetKeyV2(input.agentTargetKey);
            return parsed.kind === 'agent' ? parsed : null;
        } catch {
            return null;
        }
    }, [input.agentTargetKey]);
    const draftInput = React.useMemo(() => agentTarget && input.machineId ? {
        agentTarget,
        executionTarget: { machineId: input.machineId, ...(input.serverId ? { serverId: input.serverId } : {}) },
    } : null, [agentTarget, input.machineId, input.serverId]);
    const requests = React.useMemo(() => draftInput ? [{
        field: SPAWN_MODEL_FIELD,
        actionId: 'session.spawn_new' as const,
        draftInput,
    }] : [], [draftInput]);
    const resolveOptions = useActionFieldOptionsForMachine({
        machineId: input.machineId,
        serverId: input.serverId,
        enabled: input.enabled && draftInput !== null,
        requests,
    });
    const options = resolveOptions(SPAWN_MODEL_FIELD);
    return React.useMemo(() => draftInput === null || !input.enabled ? null : options.flatMap((option) => (
        typeof option.value === 'string' && !option.disabled
            ? [{ id: option.value, name: option.label || option.value, description: option.description ?? null }]
            : []
    )), [draftInput, input.enabled, options]);
}
