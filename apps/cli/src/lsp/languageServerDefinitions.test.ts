import { describe, expect, it } from 'vitest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry, ResolvedLanguageServerContribution } from '@/plugins/projection/registry/types';
import { createLanguageServerDefinitions } from './languageServerDefinitions';

function contribution(pluginId: string, localId: string, definition: Partial<ResolvedLanguageServerContribution['definition']> = {}): ResolvedLanguageServerContribution {
    return { provenance: 'external', source: { kind: 'path' }, pluginId, pluginVersion: '1.2.3',
        identity: { pluginId, localId }, manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
        definition: { id: localId, title: localId, languageIds: { example: 'example-lsp' },
            executable: { kind: 'systemTool', id: 'example-server' }, args: ['--stdio'], ...definition } };
}

describe('language-server definitions', () => {
    it('projects every capable declaration in registry order and reads replacement registries after reload', () => {
        const first = contribution('com.example.a', 'server', { title: 'Example server', languageIds: { tsx: 'typescriptreact' },
            rootMarkers: ['example.config'], initializationOptions: { checks: true }, settings: { example: { lint: true } } });
        const second = contribution('com.example.b', 'server', { languageIds: { tsx: 'typescriptreact' } });
        const unrelated = contribution('com.example.c', 'other');
        let current: ResolvedContributionRegistry | null = createResolvedContributionRegistry({ languageServers: [second, unrelated, first] });
        const definitions = createLanguageServerDefinitions({ readCurrentContributionRegistry: () => current });
        expect(current.languageServers).toHaveLength(3);
        expect(definitions.readLanguageServerDefinitions().map(definition => definition.id)).toEqual([
            'com.example.a/server', 'com.example.b/server', 'com.example.c/other',
        ]);
        expect(definitions.findDefinitionsForDocument({ languageId: 'tsx', path: 'src/view.tsx' })).toEqual([
            { ...first.definition, id: 'com.example.a/server', pluginId: first.pluginId, pluginVersion: first.pluginVersion, manifestPath: first.manifestPath },
            { ...second.definition, id: 'com.example.b/server', pluginId: second.pluginId, pluginVersion: second.pluginVersion, manifestPath: second.manifestPath },
        ]);
        current = createResolvedContributionRegistry({ languageServers: [unrelated] });
        expect(definitions.findDefinitionsForDocument({ languageId: 'tsx', path: 'src/view.tsx' })).toEqual([]);
        expect(definitions.readLanguageServerDefinitions().map(definition => definition.id)).toEqual(['com.example.c/other']);
        current = null;
        expect(definitions.readLanguageServerDefinitions()).toEqual([]);
    });

    it('uses declared file patterns as a fallback for unknown languages and normalizes path separators', () => {
        const matching = contribution('com.example.a', 'server', { filePatterns: ['*.example', 'config/example.*'] });
        const other = contribution('com.example.b', 'server', { filePatterns: ['*.other'] });
        const registry = createResolvedContributionRegistry({ languageServers: [other, matching] });
        const definitions = createLanguageServerDefinitions({ readCurrentContributionRegistry: () => registry });
        expect(definitions.findDefinitionsForDocument({ languageId: null, path: 'src\\nested\\file.example' }).map(definition => definition.id))
            .toEqual(['com.example.a/server']);
        expect(definitions.findDefinitionsForDocument({ languageId: 'unknown', path: 'config/example.custom' }).map(definition => definition.id))
            .toEqual(['com.example.a/server']);
        expect(definitions.findDefinitionsForDocument({ languageId: null, path: 'src/file.example.backup' })).toEqual([]);
        expect(definitions.findDefinitionsForDocument({ languageId: 'toString', path: 'src/no-extension' })).toEqual([]);
        expect(definitions.findDefinitionsForDocument({ languageId: 'example', path: 'src/no-extension' })).toHaveLength(2);
    });
});
