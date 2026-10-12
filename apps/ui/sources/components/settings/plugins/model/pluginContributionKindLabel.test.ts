import { describe, expect, it } from 'vitest';
import { resolvePluginKindShelf } from './pluginContributionKindLabel';

describe('plugin kind shelf', () => {
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
