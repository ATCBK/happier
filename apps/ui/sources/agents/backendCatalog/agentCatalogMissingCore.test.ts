import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => `t:${key}` });
});

// Plugin publication is the boundary: keep the real registry/catalog logic,
// but model an optional package unavailable in this host's generated UI input.
vi.mock('@/agents/registry/generatedBundledPluginEntries', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/agents/registry/generatedBundledPluginEntries')>();
    const { antigravity: omittedCore, ...cores } = original.BUNDLED_CANONICAL_AGENTS_CORE;
    const { antigravity: omittedUi, ...ui } = original.BUNDLED_CANONICAL_AGENTS_UI;
    void omittedCore;
    void omittedUi;
    return { ...original, BUNDLED_CANONICAL_AGENTS_CORE: cores, BUNDLED_CANONICAL_AGENTS_UI: ui };
});

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { asIconName } from '@/components/ui/icons/asIconName';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getAgentPickerOptions } from '@/agents/catalog/agentPickerOptions';
import { getPermissionModeOptionsForAgentType, normalizePermissionModeForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { getModelOptionsForAgentType } from '@/sync/domains/models/modelOptions';
import { getResolvedBackendCatalogEntries } from './getResolvedBackendCatalogEntries';
import { getResolvedAgentCatalogEntries, resolveAgentCatalogProjection } from './agentCatalogProjection';

describe('optional bundled Agent without a published UI core', () => {
    it('projects a retained Agent identity with neutral presentation without crashing the Workflow catalog', () => {
        expect(isBundledAgentId('antigravity')).toBe(true);
        expect(getAgentCore('antigravity')).toBeNull();
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude', 'antigravity'],
            acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
        });
        expect(entries.map((entry) => entry.agentId)).toEqual(['claude']);
        expect(resolveAgentCatalogProjection('antigravity', { enabledAgentIds: [] })).toMatchObject({
            agentId: 'antigravity', title: 'Antigravity', iconName: 'stack-simple', channel: null, catalogAgentId: null,
        });
        // The neutral presentation must be a glyph the icon registry ships; an unknown name draws an empty box.
        expect(asIconName(resolveAgentCatalogProjection('antigravity', { enabledAgentIds: [] }).iconName)).toBeDefined();
    });

    it('keeps launcher, Settings and Roles inventories usable and excludes unavailable bundled choices', () => {
        expect(getEnabledAgentIds({ backendEnabledByTargetKey: {} })).not.toContain('antigravity');
        expect(getAgentPickerOptions(['claude', 'antigravity']).map((row) => row.agentId)).toEqual(['claude']);
        expect(getResolvedAgentCatalogEntries({ enabledAgentIds: [] }).map((row) => row.agentId)).not.toContain('antigravity');
        expect(getPermissionModeOptionsForAgentType('antigravity')).toEqual([]);
        expect(normalizePermissionModeForAgentType('read-only', 'antigravity')).toBe('read-only');
        expect(getModelOptionsForAgentType('antigravity').map((option) => option.value)).toEqual(['default']);
    });

    it('uses the selected machine declaration when its bundled Agent has no local UI core', () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['antigravity'],
            acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
            mergedProviderProjectionById: {
                antigravity: { agentId: 'antigravity', title: 'Antigravity on this machine', isBuiltIn: true },
            },
        });
        expect(entries).toEqual([expect.objectContaining({
            agentId: 'antigravity', title: 'Antigravity on this machine', catalogAgentId: null,
            agentCatalogEntry: expect.objectContaining({ channel: null, iconName: 'stack-simple' }),
        })]);
    });
});
