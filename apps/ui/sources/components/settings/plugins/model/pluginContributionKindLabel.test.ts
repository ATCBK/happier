import { describe, expect, it } from 'vitest';
import { pluginListingAdds, resolvePluginKindShelf } from './pluginContributionKindLabel';

describe('plugin kind shelf', () => {
    it('recognizes language-server plugins above generic panels and dependencies without displacing agents', () => {
        expect(resolvePluginKindShelf(['languageServers'])?.key).toBe('languageServers');
        expect(resolvePluginKindShelf(['managedDependencies', 'pluginUi', 'languageServers'])?.key).toBe('languageServers');
        expect(resolvePluginKindShelf(['languageServers', 'agent'])?.key).toBe('agent');
    });

    it('shelves a plugin by its most identifying kind, whatever order the machine projected them in', () => {
        // Nearly every plugin signs in to something; that never outranks what the plugin is for.
        expect(resolvePluginKindShelf(['connectedAccounts', 'machineProvisioners'])?.key).toBe('machines');
        expect(resolvePluginKindShelf(['connectedAccounts', 'pluginUi', 'scmHostingProviders'])?.key).toBe('scmHostingProviders');
        expect(resolvePluginKindShelf(['pluginUi', 'voiceProviders'])?.key).toBe('voice');
        expect(resolvePluginKindShelf(['inputTypes', 'agent'])?.key).toBe('agent');
        expect(resolvePluginKindShelf(['connectedAccounts'])?.key).toBe('connectedAccounts');
    });

    it('skips plumbing contributions and leaves plumbing-only plugins without a shelf', () => {
        expect(resolvePluginKindShelf(['managedDependencies', 'accountCollections', 'dragSources', 'dropTargets', 'agent'])?.key)
            .toBe('agent');
        expect(resolvePluginKindShelf(['managedDependencies', 'accountCollections', 'dragSources', 'dropTargets', 'atmospherePictures'])).toBeNull();
    });
});

describe('what a listing adds', () => {
    it('says the manifest families in people words, once each, and leaves plumbing families out', () => {
        expect(pluginListingAdds(['agents', 'skills', 'mcp']).map((row) => row.title)).toEqual(['Agents', 'Skills', 'MCP tools']);
        expect(pluginListingAdds(['voiceProviders', 'actions', 'voiceModelPacks', 'settings']).map((row) => row.title)).toEqual(['Voice']);
        expect(pluginListingAdds(['actions', 'events'])).toEqual([]);
    });

    it('gives every listed family one line of what it brings, never the family word again', () => {
        const families = ['agents', 'skills', 'machineProvisioners', 'providers', 'scmHostingProviders', 'scmBackends',
            'languageServers', 'roles', 'workflows', 'inputTypes', 'mcp', 'connectedAccountDescriptors', 'voiceProviders',
            'composerControls', 'ui', 'browserTargets'];
        const rows = pluginListingAdds(families);
        expect(rows).toHaveLength(families.length);
        for (const row of rows) {
            expect(row.description.length).toBeGreaterThan(0);
            expect(row.description).not.toBe(row.title);
            expect(row.description).not.toMatch(/^settingsPlugins\./);
        }
        expect(new Set(rows.map((row) => row.description)).size).toBe(rows.length);
    });
});
