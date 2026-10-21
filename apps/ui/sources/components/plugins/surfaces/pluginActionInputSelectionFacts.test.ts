import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it, vi } from 'vitest';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { createPluginActionInputSelectionFactsPublication } from './pluginActionInputSelectionFacts';

function rawFacts() {
    const plugin: PluginProjectionEntry = {
        pluginId: 'acme.action', title: 'Action', description: null, version: '1.0.0', enabled: true,
        generation: 1, generationLabel: '1', status: null, provenance: null, diagnostics: [],
        actions: [], resources: [], editableSettingsGroups: [],
    };
    const protocol = { id: 'review', version: 1 };
    const contributor = { pluginId: plugin.pluginId, contributionId: 'review', occurrenceId: 'action-1',
        sourceCustody: { kind: 'development' as const, registeredRootId: 'root' } };
    const target: PluginUiTargetedContributionsV1 = {
        target: { pluginId: 'acme.target', occurrenceId: 'target-1', sourceCustody: contributor.sourceCustody },
        points: [{ pointId: 'review', protocols: [{ protocol, contributions: [{
            contributor, protocol, surfaces: [], operations: [{
                point: { pointId: 'review', protocol }, contributor, role: 'setup',
                action: { pluginId: plugin.pluginId, localId: 'configure' },
            }],
        }] }] }],
    };
    const bundles = { en: { title: 'Configure' } };
    const input = { targetPluginId: target.target.pluginId, targetedContributions: target,
        pluginProjectionById: { [plugin.pluginId]: plugin }, translationsByPluginId: {
            [plugin.pluginId]: { id: 'text', pluginId: plugin.pluginId, contributionKind: 'translations' as const, locales: ['en'], bundles },
        } };
    return { plugin, target, bundles, input };
}

describe('mounted Action selection fact publication', () => {
    it('reuses selected immutable facts with zero deep walks across unrelated catalog publications', () => {
        const raw = rawFacts();
        const plugin = projectNativeJsonValueForTransport(raw.plugin) as unknown as PluginProjectionEntry;
        const target = projectNativeJsonValueForTransport(raw.target) as unknown as PluginUiTargetedContributionsV1;
        const bundles = projectNativeJsonValueForTransport(raw.bundles) as typeof raw.bundles;
        const input = { ...raw.input, targetedContributions: target, pluginProjectionById: { [plugin.pluginId]: plugin },
            translationsByPluginId: { [plugin.pluginId]: { ...raw.input.translationsByPluginId[plugin.pluginId]!, bundles } } };
        const publication = createPluginActionInputSelectionFactsPublication();
        const keys = vi.spyOn(Object, 'keys');
        const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors');
        try {
            const initial = publication.publish(input);
            for (let index = 0; index < 100; index += 1) {
                expect(publication.publish({ ...input,
                    pluginProjectionById: { ...input.pluginProjectionById, unrelated: { ...plugin, title: `Unrelated ${index}` } },
                })).toBe(initial);
            }
            const selected = [plugin, target, bundles];
            expect(keys.mock.calls.filter(([value]) => selected.some(input => input === value))).toHaveLength(0);
            expect(descriptors.mock.calls.filter(([value]) => selected.some(input => input === value))).toHaveLength(0);
            // A new Account/physical owner retains no cross-lifetime snapshot.
            expect(createPluginActionInputSelectionFactsPublication().publish(input)).not.toBe(initial);
        } finally { keys.mockRestore(); descriptors.mockRestore(); }
    });

    it('owns raw aliases, shares equivalent new replies and replaces real target, declaration or text changes', () => {
        const raw = rawFacts();
        const publication = createPluginActionInputSelectionFactsPublication();
        const initial = publication.publish(raw.input);
        expect(publication.publish(rawFacts().input)).toBe(initial);
        raw.bundles.en.title = 'Changed raw text';
        expect(initial.selected[0]?.bundles).toEqual({ en: { title: 'Configure' } });
        const changedText = publication.publish(raw.input);
        expect(changedText).not.toBe(initial);
        const changedDeclaration = publication.publish({ ...raw.input,
            pluginProjectionById: { [raw.plugin.pluginId]: { ...raw.plugin, enabled: false } } });
        expect(changedDeclaration).not.toBe(changedText);
        const changedTarget = publication.publish({ ...raw.input, targetedContributions: {
            ...raw.target, target: { ...raw.target.target, occurrenceId: 'target-2' },
        } });
        expect(changedTarget).not.toBe(changedDeclaration);
        expect(publication.publish({ ...raw.input, targetPluginId: 'another-target' })).toMatchObject({
            hasPluginProjection: true, hasTargetedContributions: false, targetedContributions: null, selected: [],
        });
    });

    it('preserves missing versus admitted-empty refusal facts without synthesizing target authority', () => {
        const publication = createPluginActionInputSelectionFactsPublication();
        const absent = publication.publishEmpty({ hasPluginProjection: false, hasTargetedContributions: false });
        const empty = publication.publishEmpty({ hasPluginProjection: true, hasTargetedContributions: true });
        expect(empty).not.toBe(absent);
        expect(empty).toMatchObject({ hasPluginProjection: true, hasTargetedContributions: true,
            targetedContributions: null, selected: [] });
        const raw = rawFacts();
        expect(publication.publish({ ...raw.input, targetedContributions: { ...raw.target, points: [] } })).toBe(empty);
        expect(publication.publish({ ...raw.input, pluginProjectionById: null })).toBe(
            publication.publishEmpty({ hasPluginProjection: false, hasTargetedContributions: true }),
        );
        const selected = publication.publish(raw.input);
        expect(selected).not.toBe(empty);
        expect(publication.publishEmpty({ hasPluginProjection: false, hasTargetedContributions: false })).not.toBe(selected);
        expect(publication.publish({ ...raw.input, pluginProjectionById: {} }).selected[0]?.plugin).toBeNull();
        expect(publication.publish(raw.input).selected[0]?.plugin).not.toBeNull();
    });
});
