import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { resolveAccountPluginActivationSources } from './accountPluginActivationSource';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import { createCommittedContributedActionInvoker, createCommittedContributedActionDefinitionLister,
    createCommittedContributedActionSchemaReader } from './invocation/actions/createCommittedContributedActionDeps';
import { createActionExecutor } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';

describe('Account activation source assembly', () => {
    it('loads an Account release through canonical Artifact bytes without a Machine and retires on disable', async () => {
        const home = await mkdtemp(join(tmpdir(), 'account-source-'));
        const app = fastify();
        const { pluginId, manifest, setEnabled } = await registerAuthoredAccountActionRelease(app, 'owner');
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-source.test' });
        try {
            const result = await resolveAccountPluginActivationSources({ contributes: createResolvedContributionRegistry({}),
                paths: resolvePluginStorePaths({ happyHomeDir: home }), credentials: { token: 'fixture', encryption: null },
                serverUrl: 'http://account-source.test', isCurrent: () => true, resolveBundledActivationSource: () => null });
            expect(result.contributes.actions.map(action => action.definition.id)).toEqual(manifest.contributes.actions.map(action => action.id));
            expect(result.contributes.activationTargets).toMatchObject([{ account: { artifactId: 'account-runtime', exportName: 'activate' } }]);
            const module = await result.sourcesByPluginId.get(pluginId)?.resolveRelativeModule?.('account-runtime');
            expect(typeof module?.module.activate).toBe('function');
            expect(result.isCurrent(pluginId)).toBe(true);
            const cli = createCliActionExecutor({ token: 'fixture',
                credentials: { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' },
                happyHomeDir: home, sessionId: 'cli-global', mode: 'plain', ctx: null,
                serverId: 'account-source', serverHttpBaseUrl: 'http://account-source.test' });
            for (const surface of ['cli', 'agent', 'mcp'] as const) {
                expect(await cli.execute('action.invoke', { action: { pluginId, localId: 'echo' }, input: { key: surface } }, { surface }))
                    .toMatchObject({ ok: true, result: { key: surface, surface } });
            }
            expect(await cli.execute('action.spec.get', { id: formatQualifiedPluginActionId({ pluginId, localId: 'echo' }) }, { surface: 'cli' }))
                .toMatchObject({ ok: true, result: { actionSpec: { executionPlacement: 'account' } } });
            expect(await cli.execute('action.invoke', { action: { pluginId, localId: 'source' }, input: { key: 'provider' } }, { surface: 'cli' }))
                .toMatchObject({ ok: false, errorCode: 'plugin_action_machine_required' });
            const registry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: home, contributes: createResolvedContributionRegistry({}),
                accountExecution: { credentials: { token: 'fixture', encryption: null },
                    serverUrl: 'http://account-source.test', isCurrent: () => true },
            });
            try {
                const lease = { registry, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
                const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                    listContributedActionDefinitions: list,
                    readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
                    invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => lease }),
                });
                expect(await executor.execute('action.invoke', { action: { pluginId, localId: 'echo' }, input: { key: 'retained' } }, { surface: 'cli' }))
                    .toMatchObject({ ok: true, result: { key: 'retained', surface: 'cli' } });
                setEnabled(false);
                expect(await executor.execute('action.invoke', { action: { pluginId, localId: 'echo' }, input: { key: 'retained' } }, { surface: 'cli' }))
                    .toMatchObject({ ok: false, errorCode: 'plugin_action_generation_retired' });
            } finally { await registry.dispose(); }
            setEnabled(false);
            expect(await cli.execute('action.invoke', { action: { pluginId, localId: 'echo' }, input: { key: 'disabled' } }, { surface: 'cli' }))
                .toMatchObject({ ok: false, errorCode: 'plugin_disabled' });
            expect(await result.revalidate(pluginId)).toBe(false);
            expect(result.isCurrent(pluginId)).toBe(false);
            await expect(result.sourcesByPluginId.get(pluginId)?.resolveRelativeModule?.('account-runtime')).rejects.toThrow();
        } finally { restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
    });
});
