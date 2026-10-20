import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { RpcHandler } from '@/api/rpc/types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { resolveRegistryConnectedAccountActionFormPurposeAuthorization } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';

describe('cold installed plugin Action form admission', () => {
    it.each([['channel-email', 'channel/setup-v1'], ['channel-telegram', 'telegram/prepare-bot']] as const)('admits the authored %s setup credential field through the canonical form-purpose owner', async (packageId, setupId) => {
        const { PLUGIN_MANIFEST }: Readonly<{ PLUGIN_MANIFEST: unknown }> = await import(
            new URL(`../../../../../packages/plugins/${packageId}/src/plugin.ts`, import.meta.url).href
        );
        const manifest = readCanonicalPluginManifest(PLUGIN_MANIFEST);
        if (!manifest) throw new Error('Expected authored provider manifest');
        const setup = manifest.contributes.actions.find(action => action.id === setupId);
        if (!setup) throw new Error('Expected declared provider setup Action');
        const registry = { activationTargets: [{ pluginId: manifest.id, manifest }] };
        expect(resolveRegistryConnectedAccountActionFormPurposeAuthorization({ registry,
            qualifiedActionId: `${manifest.id}/${setup.id}`, fieldPath: 'credentialRef' })).toMatchObject({
            action: { pluginId: manifest.id, localId: setup.id },
            serviceRefs: [expect.objectContaining({ pluginId: manifest.id })],
        });
    });

    it('offers Connected Accounts before activating the selected Action, and refuses a retired occurrence', async () => {
        const pluginId = 'acme.cold-setup';
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            coldStart: true,
            plugins: [{ manifest: createPluginManifestV2Fixture({ id: pluginId,
                hostAccess: { required: [{ id: 'select-account', capability: 'connectedAccounts', reason: 'Select setup account',
                    scope: { serviceRefs: ['account'], operations: ['select', 'use'] } }], optional: [] },
                contributes: { connectedAccountDescriptors: [{ id: 'account', title: 'Account', authentication: {
                    defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                        fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }],
                } }], actions: [{ id: 'setup', title: 'Setup', scopes: ['settings'], surfaces: ['plugin'],
                    dangerLevel: 'safe', execution: { target: 'daemon' }, hostAccess: ['select-account'],
                    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'select-account' }],
                    inputSchema: { type: 'object', properties: { credentialRef: QualifiedConnectedAccountRefJsonSchema },
                        required: ['credentialRef'], additionalProperties: false },
                    inputHints: { fields: [{ path: 'credentialRef', title: 'Account', widget: 'select', connectedAccountOptions: true }] },
                }] },
            }), files: { 'daemon.mjs': "export function activate(api) { api.actions.register('setup', () => ({})); }" } }],
            runtimeOptions: { resolveCurrentMachineId: () => 'machine-1' },
        });
        try {
            const occurrenceId = fixture.registry.readPluginOccurrenceId?.(pluginId);
            expect(occurrenceId).toBeTruthy();
            expect(fixture.registry.targetActionInvocations?.has(pluginId, 'setup')).toBe(false);
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => fixture.registry,
                resolveConnectedAccountPurposeBindingRuntime: () => ({ listActionFormConnectedAccountOptions: async () => [{
                    label: 'Setup account', value: { service: { pluginId, localId: 'account' }, accountId: 'account-1' },
                }] }),
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_ACTION_FORM_CONNECTED_ACCOUNT_OPTIONS_RESOLVE);
            if (!handler) throw new Error('Expected real Action-form RPC');
            const request = { machineId: 'machine-1', expectedOccurrenceId: occurrenceId,
                qualifiedActionId: `${pluginId}/setup`, fieldPath: 'credentialRef' };
            expect(await handler(request)).toEqual({ ok: true, options: [{ label: 'Setup account',
                value: { service: { pluginId, localId: 'account' }, accountId: 'account-1' } }] });
            expect(fixture.registry.targetActionInvocations?.has(pluginId, 'setup')).toBe(false);
            fixture.registry.fencePluginConsumers?.([pluginId]);
            expect(await handler(request)).toMatchObject({ ok: false });
        } finally { await fixture.dispose(); }
    });
});
