import { describe, expect, it } from 'vitest';
import { derivePluginAccountContributionRegistrationRights, derivePluginContributionRegistrationRights, derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { createPluginRegistrationScope } from '../host/registration/index.js';
import { definePlugin } from '../definePlugin.js';

describe('Account action registration through the shared activation ABI', () => {
    it('accepts declaration-only Account Actions registered by a separate portable artifact', () => {
        const plugin = definePlugin({ id: 'acme.separate', version: '1.0.0', actions: {
            read: { title: 'Read', surfaces: ['plugin'], execution: { target: 'account',
                account: { artifactId: 'portable', exportName: 'activate' } } },
        } });
        const target = { artifactId: 'portable', exportName: 'activate' };
        const scope = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'account', ...target },
            rights: derivePluginAccountContributionRegistrationRights(plugin.manifest.contributes, target) });
        expect(() => plugin.activateAccount(scope.api)).toThrow(TypeError);
        const activate = (api: typeof scope.api) => api.actions.register('read', () => ({ value: 'portable' }));
        activate(scope.api);
        expect(scope.commit()).toMatchObject([{ family: 'actions', localId: 'read' }]);
    });
    it('activates authored Account Actions without registering them in the daemon realm', async () => {
        const plugin = definePlugin({ id: 'acme.account', version: '1.0.0', actions: {
            read: { title: 'Read', surfaces: ['plugin'], execution: {
                target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' },
            }, run: () => ({ retained: true }) },
        } });
        const scope = createPluginRegistrationScope({ pluginId: plugin.manifest.id,
            target: { realm: 'account', artifactId: 'account-runtime', exportName: 'activateAccount' },
            rights: derivePluginContributionRegistrationRights(plugin.manifest.contributes),
        });
        await plugin.activateAccount(scope.api);
        expect(scope.commit()).toMatchObject([{ family: 'actions', localId: 'read' }]);
        const daemon = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'daemon' },
            rights: derivePluginDaemonContributionRegistrationRights(plugin.manifest.contributes) });
        await plugin.activate(daemon.api);
        expect(daemon.commit()).toEqual([]);
        await Promise.all([scope.dispose(), daemon.dispose()]);
    });
    it('requires an exact target when an author has several portable activation exports', () => {
        const plugin = definePlugin({ id: 'acme.account', version: '1.0.0', actions: {
            first: { title: 'First', surfaces: ['plugin'], execution: { target: 'account',
                account: { artifactId: 'one', exportName: 'activate' } }, run: () => null },
            second: { title: 'Second', surfaces: ['plugin'], execution: { target: 'account',
                account: { artifactId: 'two', exportName: 'activate' } }, run: () => null },
        } });
        const target = { artifactId: 'two', exportName: 'activate' };
        const scope = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'account', ...target },
            rights: derivePluginAccountContributionRegistrationRights(plugin.manifest.contributes, target) });
        expect(() => plugin.activateAccount(scope.api)).toThrow(TypeError);
        plugin.activateAccount(scope.api, target);
        expect(scope.commit().map((registration) => registration.localId)).toEqual(['second']);
    });
    it('commits the exact portable handler and retires it through the existing scope', async () => {
        const target = { realm: 'account', artifactId: 'account-runtime', exportName: 'activateAccount' } as const;
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.account', target,
            rights: derivePluginContributionRegistrationRights({ actions: [{ id: 'read', execution: {
                target: 'account', account: { artifactId: target.artifactId, exportName: target.exportName },
            } }] }),
        });
        const activate = (api: typeof scope.api) => api.actions.register('read', () => ({ retained: true }));
        activate(scope.api);
        const [registration] = scope.commit();
        expect(registration).toMatchObject({ family: 'actions', localId: 'read' });
        expect(Object.keys(scope.api)).toEqual(['actions']);
        await scope.dispose();
        expect(scope.registrations()).toEqual([]);
    });
});
