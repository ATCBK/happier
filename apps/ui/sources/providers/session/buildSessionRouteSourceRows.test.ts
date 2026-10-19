import { describe, expect, it } from 'vitest';

import { createProviderConnectionViewFixture } from '@/dev/testkit/harness/providerSettingsHarness';

import { buildSessionRouteSourceRows } from './buildSessionRouteSourceRows';

const CODEX = 'agent:happier.agent.codex/codex';
const CLAUDE = 'agent:happier.agent.claude/claude';

describe('buildSessionRouteSourceRows', () => {
    it('keeps a compatible source browseable before it has any projected model rows', () => {
        const rows = buildSessionRouteSourceRows({ agentTargetKey: CODEX, isGateway: () => true,
            views: [createProviderConnectionViewFixture({ connectionId: 'pc_gateway',
                compatibility: [{ agentTargetKey: CODEX, agentName: 'Codex', status: 'verified', reasons: [] }] })],
            shownSources: [], hiddenSources: [] });
        expect(rows.gateways).toEqual([expect.objectContaining({ connectionId: 'pc_gateway', modelCount: null, worksWith: null })]);
    });
    it('retains admitted Provider contribution identity for its packaged mark', () => {
        const contributionKey = 'happier.provider.deepseek/deepseek';
        const rows = buildSessionRouteSourceRows({ agentTargetKey: CODEX, isGateway: () => false,
            views: [createProviderConnectionViewFixture({ contributionKey, icon: 'cube' })],
            shownSources: [{ connectionId: 'pc_a', rows: [{}] }], hiddenSources: [] });
        expect(rows.providers[0]).toMatchObject({ contributionKey, icon: 'cube' });
    });
    it('carries the declared gateway glyph and contribution identity without a machine icon', () => {
        const contributionKey = 'happier.provider.cliproxyapi/cliproxyapi';
        const rows = buildSessionRouteSourceRows({
            agentTargetKey: CODEX,
            isGateway: () => true,
            views: [createProviderConnectionViewFixture({ connectionId: 'pc_gateway', contributionKey,
                icon: null, deployment: { kind: 'managedLocal', targetMachineId: null, effects: null } })],
            shownSources: [{ connectionId: 'pc_gateway', rows: [{}] }], hiddenSources: [],
        });
        expect(rows.gateways[0]).toMatchObject({ contributionKey, icon: 'path' });
    });
    it('lists shown and hidden sources to browse and keeps an incompatible one, naming the Agents it works with', () => {
        const rows = buildSessionRouteSourceRows({
            agentTargetKey: CODEX,
            isGateway: view => view.connectionId === 'pc_gateway',
            views: [
                createProviderConnectionViewFixture({ connectionId: 'pc_gateway', providerName: 'Main gateway', displayName: 'Main gateway' }),
                createProviderConnectionViewFixture({ connectionId: 'pc_shown', providerName: 'Ollama', displayName: 'Ollama' }),
                createProviderConnectionViewFixture({ connectionId: 'pc_hidden', providerName: 'OpenRouter', displayName: 'Work',
                    role: 'named', displayNameMode: 'custom' }),
                createProviderConnectionViewFixture({ connectionId: 'pc_other', providerName: 'DeepSeek', displayName: 'DeepSeek',
                    compatibility: [
                        { agentTargetKey: CODEX, agentName: 'Codex', status: 'incompatible', reasons: ['no_compatible_protocol'] },
                        { agentTargetKey: CLAUDE, agentName: 'Claude Code', status: 'verified', reasons: [] },
                    ] }),
                // Offers this Agent nothing and is not known to be incompatible: not a route to name.
                createProviderConnectionViewFixture({ connectionId: 'pc_empty', providerName: 'Empty', displayName: 'Empty' }),
            ],
            // The hidden source keeps one favorite in the main picker; it is still a hidden source.
            shownSources: [{ connectionId: 'pc_shown', rows: [{}, {}, {}, {}] }, { connectionId: 'pc_hidden', rows: [{}] }],
            hiddenSources: [{ connectionId: 'pc_hidden', modelCount: 312 }, { connectionId: 'pc_gateway', modelCount: 9 }],
        });

        expect(rows.gateways).toEqual([
            { connectionId: 'pc_gateway', contributionKey: 'acme.plugin/acme', label: 'Main gateway', icon: null, modelCount: 9, hiddenFromPicker: true, worksWith: null },
        ]);
        expect(rows.providers).toEqual([
            { connectionId: 'pc_other', contributionKey: 'acme.plugin/acme', label: 'DeepSeek', icon: null, modelCount: null, hiddenFromPicker: false, worksWith: ['Claude Code'] },
            { connectionId: 'pc_shown', contributionKey: 'acme.plugin/acme', label: 'Ollama', icon: null, modelCount: 4, hiddenFromPicker: false, worksWith: null },
            { connectionId: 'pc_hidden', contributionKey: 'acme.plugin/acme', label: 'OpenRouter · Work', icon: null, modelCount: 313, hiddenFromPicker: true, worksWith: null },
        ]);
    });
});
