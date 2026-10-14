import { describe, expect, it } from 'vitest';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { projectAgentModelChoices, type AgentModelChoiceSource } from './projectAgentModelChoices';

describe('shared background Agent/model choices', () => {
    const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: ['codex'], acpCatalogSnapshot: {
        status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
            id: 'codex', name: 'custom', title: 'Custom runner', launch: { kind: 'command', command: 'acp', args: [] }, createdAt: 1, updatedAt: 1,
        }] }),
    } });
    const models = [{ id: 'structured', name: 'Structured', costTier: 'low' as const, capabilities: { structuredOutput: 'supported' as const } },
        { id: 'text-only', name: 'Text', capabilities: { structuredOutput: 'unsupported' as const } }];
    const sources: readonly AgentModelChoiceSource[] = entries.map(entry => ({ entry, models, catalogModels: models, runnerCapable: true, discoverable: true }));
    const configuredKey = 'agent:happier.agent.custom-acp/custom-acp:definition:codex';

    it('shares grouping, cost/default facts and exact configured identity while filtering by purpose', () => {
        const selected = ProviderBoundModelRefSchema.parse({ agentTargetKey: configuredKey, providerConnectionId: null, modelId: 'custom/model' });
        const walkthrough = projectAgentModelChoices({ purpose: 'walkthrough', sources, selected, defaultModelTitle: 'Default' });
        expect(walkthrough.groups).toHaveLength(2);
        expect(walkthrough.groups.every(group => group.offered.length === 1 && group.hiddenModelCount === 1)).toBe(true);
        expect(walkthrough.defaultProfile).toMatchObject({ costTier: 'low', modelSelector: { modelId: 'structured' } });
        expect([...walkthrough.selections.values()].some(choice => choice.modelSelection.modelId === 'custom/model')).toBe(false);
        const runner = projectAgentModelChoices({ purpose: 'runner', sources, selected, defaultModelTitle: 'Default' });
        const group = runner.groups.find(candidate => candidate.targetKey === configuredKey)!;
        expect(group.offered.map(model => model.modelSelector?.modelId)).toEqual(['default', 'structured', 'text-only', 'custom/model']);
        expect(group.customModelIdAllowed).toBe(true);
        const custom = [...runner.selections.values()].find(choice => choice.modelSelection.modelId === 'custom/model')!;
        expect(custom.backendTarget).toMatchObject({ backendId: 'codex', configuredBackendId: 'codex' });
        expect(custom.modelSelection).toEqual(selected);
        expect(runner.defaultProfile?.modelSelector).toMatchObject({ backendTargetKey: configuredKey, modelId: 'default' });
    });
    it('does not offer declared non-runner targets or substitute another target for an unavailable custom choice', () => {
        const selected = ProviderBoundModelRefSchema.parse({ agentTargetKey: configuredKey, providerConnectionId: null, modelId: 'custom/model' });
        const result = projectAgentModelChoices({ purpose: 'runner', sources: sources.map(source => ({ ...source, runnerCapable: false })), selected, defaultModelTitle: 'Default' });
        expect(result.groups).toEqual([]);
        expect(result.selections.size).toBe(0);
        expect(result.defaultProfile).toBeNull();
    });
});
