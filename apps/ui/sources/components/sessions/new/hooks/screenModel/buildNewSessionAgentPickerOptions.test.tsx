import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

import { buildNewSessionAgentPickerOptions } from './buildNewSessionAgentPickerOptions';
import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { createResolvedAgentCatalogEntryFixture } from '@/dev/testkit/fixtures/agentCatalogFixtures';
import { settingsDefaults } from '@/sync/domains/settings/settings';

function createEntry(params: Readonly<{
    backendId: string;
    kind: ResolvedBackendCatalogEntry['kind'];
    title: string;
    providerId?: string;
    catalogAgentId?: ResolvedBackendCatalogEntry['catalogAgentId'];
    builtInAgentId?: ResolvedBackendCatalogEntry['builtInAgentId'];
    capabilities?: ResolvedBackendCatalogEntry['capabilities'];
}>): ResolvedBackendCatalogEntry {
    const backendTarget = params.kind === 'configuredBackend'
        ? { kind: 'backend' as const, backendId: params.backendId, configuredBackendId: params.backendId }
        : { kind: 'backend' as const, backendId: params.backendId };
    return {
        agentCatalogEntry: createResolvedAgentCatalogEntryFixture({
            agentId: params.providerId ?? params.backendId,
        }),
        backendTarget,
        backendTargetKey: formatBackendTargetKeyV2(backendTarget),
        kind: params.kind,
        backendId: params.backendId,
        agentId: params.providerId ?? params.backendId,
        catalogAgentId: params.catalogAgentId ?? null,
        builtInAgentId: params.builtInAgentId ?? null,
        iconAgentId: params.catalogAgentId ?? params.builtInAgentId ?? null,
        capabilities: params.capabilities ?? null,
        title: params.title,
        subtitle: null,
        cliAuthBackgroundCheckSafe: false,
    };
}

describe('buildNewSessionAgentPickerOptions', () => {
    it('shows one Antigravity option and filters review-only engines out of the session picker', () => {
        const claude = createEntry({
            backendId: 'claude',
            kind: 'builtInAgent',
            title: 'Claude',
            providerId: 'claude',
            catalogAgentId: 'claude',
            builtInAgentId: 'claude',
            capabilities: { session: { supported: true } },
        });
        const antigravity = createEntry({
            backendId: 'antigravity-localharness',
            kind: 'builtInAgent',
            title: 'Antigravity',
            providerId: 'antigravity',
            catalogAgentId: 'antigravity',
            builtInAgentId: 'antigravity',
            capabilities: { session: { supported: true } },
        });
        const codeRabbit = createEntry({
            backendId: 'coderabbit',
            kind: 'pluginBackend',
            title: 'CodeRabbit',
            providerId: 'coderabbit',
            capabilities: {
                session: { supported: false },
                executionRun: { supported: true },
            },
        });
        const deepSec = createEntry({
            backendId: 'deepsec',
            kind: 'pluginBackend',
            title: 'DeepSec',
            providerId: 'deepsec',
            capabilities: {
                session: { supported: false },
                executionRun: { supported: true },
            },
        });

        const result = buildNewSessionAgentPickerOptions({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claude, antigravity, codeRabbit, deepSec],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            getEngineSelectionForTargetKey: () => ({ modelId: 'default', sessionModeId: null, configOverrides: {} }),
            selectEngineSelection: vi.fn(),
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            selectedBackendTargetKey: antigravity.backendTargetKey,
            selectedModelId: 'default',
            readSettings: () => settingsDefaults,
        });

        expect(result.selectableBackendEntries.map((entry) => entry.backendId)).toEqual(['claude', 'antigravity-localharness']);
        expect(result.agentPickerOptions?.map((option) => option.label)).toEqual(['Claude', 'Antigravity']);
    });

    it('names a per-Agent reason on its rail row but leaves an unknown machine to the picker header', () => {
        const entry = (id: 'claude' | 'codex') => createEntry({
            backendId: id, kind: 'builtInAgent', title: id, providerId: id, catalogAgentId: id, builtInAgentId: id,
            capabilities: { session: { supported: true } },
        });
        const claude = entry('claude');
        const codex = entry('codex');
        const result = buildNewSessionAgentPickerOptions({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claude, codex],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => false,
            // Nothing is known about Claude on an unreachable machine; Codex is known to be signed out.
            getBackendEntryUnavailabilityReason: (candidate) => candidate === claude ? 'agent-not-ready:claude' : 'logged-out:codex',
            getEngineSelectionForTargetKey: () => ({ modelId: 'default', sessionModeId: null, configOverrides: {} }),
            selectEngineSelection: vi.fn(),
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            selectedBackendTargetKey: claude.backendTargetKey,
            selectedModelId: 'default',
            readSettings: () => settingsDefaults,
        });

        const byLabel = new Map(result.agentPickerOptions?.map((option) => [option.label, option]));
        expect(byLabel.get('claude')?.subtitle).toBeUndefined();
        expect(byLabel.get('codex')?.subtitle).toBe('profiles.machineLogin.status.notLoggedIn');
    });
});
