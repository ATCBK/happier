import { describe, expect, it } from 'vitest';
import {
    admitPluginListFilterFieldV1, admitPluginListFilterFieldValueV1, compileEntityListFilterV1,
    createPluginListFilterFieldRegistryV1, type PluginListFilterFactsV1, type PluginListFilterSelectionV1,
} from './CollectionFilter.js';

describe('public plugin collection filter adapter', () => {
    it('filters independent plugin-owned release facts and preserves unavailable selections over retirement', () => {
        const declared = { id: 'release-stage', title: 'Release stage', source: { factKey: 'releaseStage' }, value: { kind: 'set' } } as const;
        const admitted = admitPluginListFilterFieldV1({ pluginId: 'test.release', field: declared, factKeys: new Set(['releaseStage']) });
        if (admitted.kind !== 'admitted') throw new Error('Invalid fixture');
        const selection: PluginListFilterSelectionV1 = { extensions: { [admitted.field.id]: { kind: 'set', include: ['ready'], exclude: [] } } };
        const rows = [{ id: 'ready', stage: 'ready' }, { id: 'draft', stage: 'draft' }].map(row => {
            const value = admitPluginListFilterFieldValueV1(declared, row.stage);
            if (value.kind !== 'available') throw new Error('Invalid fact fixture');
            return { id: row.id, extensions: { [admitted.field.id]: value.value } };
        });
        const registry = createPluginListFilterFieldRegistryV1<PluginListFilterSelectionV1, PluginListFilterFactsV1>([admitted.field]);
        const match = compileEntityListFilterV1(registry, selection);
        expect(rows.filter(row => match(row) === 'match').map(row => row.id)).toEqual(['ready']);
        expect(match({})).toBe('unavailable');
        const retired = createPluginListFilterFieldRegistryV1<PluginListFilterSelectionV1, PluginListFilterFactsV1>([]);
        expect(compileEntityListFilterV1(retired, selection)(rows[0]!)).toBe('unavailable');
        expect(compileEntityListFilterV1(registry, selection)(rows[0]!)).toBe('match');
    });
});
