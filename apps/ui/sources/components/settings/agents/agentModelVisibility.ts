import { getAgentStaticModels } from '@happier-dev/agents';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';

import { isBundledAgentId } from '@/agents/catalog/catalog';
import type { ProviderModelManagerNativeModel } from '@/providers/models/ProviderModelManager';

/** The part of a model projection group the summary reads. */
type ProjectedModelGroup = Readonly<{ rows: ReadonlyArray<Readonly<{ visibility: string }>> }>;

/**
 * An agent's own models, each marked hidden when this Account hid it for the agent. Agent → Models
 * lists them and the Session-default summary counts them, from this one reading.
 */
export function resolveAgentNativeModels(params: Readonly<{
    runtimeAgentId: string | null;
    agentTargetKey: string;
    modelVisibilityByRef: Readonly<Record<string, unknown>>;
    observedModels?: ReadonlyArray<Readonly<{
        id: string;
        name: string;
        description?: string | null;
        contextWindowTokens?: number;
    }>>;
}>): ProviderModelManagerNativeModel[] {
    if (!params.runtimeAgentId || !isBundledAgentId(params.runtimeAgentId)) return [];
    const models = params.observedModels === undefined
        ? getAgentStaticModels(params.runtimeAgentId)
        : params.observedModels.length > 0
            ? params.observedModels
            : getAgentStaticModels(params.runtimeAgentId, { catalogOnly: true });
    return models.map((model) => ({
        id: model.id,
        name: model.name || model.id,
        ...(typeof model.description === 'string' ? { description: model.description } : {}),
        ...(typeof model.contextWindowTokens === 'number' ? { contextWindowTokens: model.contextWindowTokens } : {}),
        hidden: Object.prototype.hasOwnProperty.call(params.modelVisibilityByRef, serializeModelVisibilityRefV1({
            scope: 'agent', agentTargetKey: params.agentTargetKey, providerConnectionId: null, modelId: model.id,
        })),
    }));
}

/**
 * "7 shown · 1 hidden": what the agent's model picker offers (its own visible models plus the rows the
 * picker projection keeps, favorites of hidden sources included) and the models hidden one by one.
 * Models behind a source's "Show in model picker" switch are neither; Agent → Models explains them.
 */
export function summarizeAgentModelVisibility(params: Readonly<{
    nativeModels: readonly ProviderModelManagerNativeModel[];
    pickerGroups: readonly ProjectedModelGroup[];
    managementGroups: readonly ProjectedModelGroup[];
}>): Readonly<{ shown: number; hidden: number }> {
    const nativeHidden = params.nativeModels.filter((model) => model.hidden).length;
    const count = (groups: readonly ProjectedModelGroup[], hidden: boolean) => groups.reduce(
        (total, group) => total + group.rows.filter((row) => (row.visibility === 'hidden_agent' || row.visibility === 'hidden_all_agents') === hidden).length,
        0,
    );
    return {
        shown: params.nativeModels.length - nativeHidden + count(params.pickerGroups, false),
        hidden: nativeHidden + count(params.managementGroups, true),
    };
}
