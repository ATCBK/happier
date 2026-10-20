import fastify from 'fastify';
import axios from 'axios';
import { describe, expect, it } from 'vitest';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionOutputV1Schema, normalizePluginReleaseFactsV1, resolvePluginAccountExecutionSelectionV1, computePluginAccountBundledDeclarationDigestV1 } from '@happier-dev/protocol/plugins/availability';
import type { DaemonPluginStructuredMessageActionMountedBinding } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { deriveMountedPluginInvocationCaller } from './mountedPluginInvocationCaller';

describe('Account nested Action caller provenance', () => {
    it('uses current Account declaration custody without a Machine occurrence and retires changed or disabled callers', async () => {
        const pluginId = 'com.acme.portable';
        const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({ id: pluginId, entrypoints: {}, contributes: {
            actions: [{ id: 'aggregate', title: 'Aggregate', scopes: ['global'], surfaces: ['cli'], dangerLevel: 'safe',
                placementBindings: [], execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } }],
        } }));
        let enabled = true;
        let bundled = false;
        let currentManifest = manifest;
        let receivingMachineId = 'reading-machine';
        let archiveDigestSha256 = `sha256:${'a'.repeat(64)}`;
        const app = fastify();
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () =>
            PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1, hostingCapability: { enabled: false },
                intent: { pluginId, desiredVersion: bundled ? null : manifest.version, enabled, offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
                release: bundled ? null : normalizePluginReleaseFactsV1({ ref: { pluginId, version: manifest.version }, archiveDigestSha256,
                    normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] } }), uiArtifacts: [], packageAssets: [] }));
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-provenance.test' });
        try {
            const binding = { pluginId, contributionLocalId: 'aggregate', occurrenceId: 'invoking-process-only',
                sourceCustody: { kind: 'account_release' as const, pluginId, version: manifest.version, archiveDigestSha256 } };
            const registry = { contributes: {} };
            const resolveAccountExecutionSelection = async (currentPluginId: string) => resolvePluginAccountExecutionSelectionV1({ pluginId: currentPluginId,
                intentRead: PluginAvailabilityIntentReadActionOutputV1Schema.parse((await axios.post(
                    `http://account-provenance.test${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']}`,
                    { pluginId: currentPluginId }, { headers: { Authorization: 'Bearer fixture' } },
                )).data),
                bundled: { manifest: currentManifest, sourceCustody: { kind: 'bundled_first_party', packagedRuntime: {
                    kind: 'source_declaration', packageName: '@acme/portable', declarationDigest: computePluginAccountBundledDeclarationDigestV1(currentManifest),
                } }, custodyId: computePluginAccountBundledDeclarationDigestV1(currentManifest) },
            });
            const resolveExecutionOriginContext = async () => ({ serverIdentityId: 'srv_account-provenance', machineId: receivingMachineId });
            const derive = (contributionLocalId = 'aggregate', callerBinding: DaemonPluginStructuredMessageActionMountedBinding = binding,
                targetMachineId = 'reading-machine') => deriveMountedPluginInvocationCaller({
                request: { machineId: targetMachineId, invocationSurface: 'cli',
                    invocation: { kind: 'clientPluginAction', clientActionBinding: { ...callerBinding, contributionLocalId } } },
                registry,
                resolveAccountExecutionSelection,
                resolveExecutionOriginContext,
            });
            expect((await resolveAccountExecutionSelection(pluginId)).kind).toBe('available');
            const caller = await derive();
            expect(caller.status).toBe('available');
            if (caller.status !== 'available') throw new Error('Expected Account caller');
            expect(caller.caller).toEqual({ kind: 'plugin', pluginId,
                contribution: { id: 'aggregate', qualifiedId: `${pluginId}/aggregate` }, occurrenceId: binding.occurrenceId,
                sourceCustody: binding.sourceCustody, originSurface: 'cli' });
            expect(await caller.isMountedCallerCurrent()).toBe(true);
            expect(await derive('aggregate', binding, 'different-machine')).toEqual({ status: 'unavailable' });
            receivingMachineId = 'replacement-machine';
            expect(await caller.isMountedCallerCurrent()).toBe(false);
            receivingMachineId = 'reading-machine';
            expect(await derive('not-declared')).toEqual({ status: 'unavailable' });
            expect(await derive('aggregate', { ...binding, declarationDigest: `sha256:${'e'.repeat(64)}` })).toEqual({ status: 'unavailable' });
            expect(await derive('aggregate', { ...binding, materializationRef: {
                pluginId, machineId: 'reading-machine', materializationId: 'fabricated-machine-custody',
            } })).toEqual({ status: 'unavailable' });
            expect(await deriveMountedPluginInvocationCaller({ request: { machineId: 'reading-machine', invocationSurface: 'ui',
                invocation: { kind: 'mountedPluginSurface', mountedBinding: binding } }, registry, resolveAccountExecutionSelection,
                resolveExecutionOriginContext,
            })).toEqual({ status: 'unavailable' });
            archiveDigestSha256 = `sha256:${'b'.repeat(64)}`;
            expect(await caller.isMountedCallerCurrent()).toBe(false);
            expect(await derive()).toEqual({ status: 'unavailable' });
            enabled = true;
            bundled = true;
            const bundledBinding: DaemonPluginStructuredMessageActionMountedBinding = { ...binding, pluginVersion: manifest.version,
                declarationDigest: computePluginAccountBundledDeclarationDigestV1(manifest),
                sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'app_bundle', bundleId: 'invoking-app-bundle' } } };
            const bundledCaller = await derive('aggregate', bundledBinding);
            expect(bundledCaller.status).toBe('available');
            if (bundledCaller.status !== 'available') throw new Error('Expected bundled Account caller');
            expect(bundledCaller.caller).not.toHaveProperty('materialization');
            expect(bundledCaller.caller).not.toHaveProperty('executionOrigin');
            expect(await derive('aggregate', { ...bundledBinding, pluginVersion: '2.0.0' })).toEqual({ status: 'unavailable' });
            expect(await derive('aggregate', { ...bundledBinding, declarationDigest: `sha256:${'e'.repeat(64)}` })).toEqual({ status: 'unavailable' });
            expect(await derive('aggregate', { ...bundledBinding, declarationDigest: undefined })).toEqual({ status: 'unavailable' });
            currentManifest = normalizePluginManifestV2({ ...manifest, contributes: { ...manifest.contributes,
                actions: manifest.contributes.actions.map(action => ({ ...action, dangerLevel: 'writesRemote',
                    confirmation: { title: 'Confirm changed declaration' } })),
            } });
            expect(await bundledCaller.isMountedCallerCurrent()).toBe(false);
            archiveDigestSha256 = binding.sourceCustody.archiveDigestSha256;
            enabled = false;
            expect(await caller.isMountedCallerCurrent()).toBe(false);
            expect(await derive()).toEqual({ status: 'unavailable' });
        } finally { restore(); await app.close(); }
    });
});
