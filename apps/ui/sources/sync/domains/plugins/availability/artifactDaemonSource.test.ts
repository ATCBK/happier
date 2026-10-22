import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const guardedMachineRpc = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => guardedMachineRpc(...args),
}));

import { encodeBase64 } from '@/encryption/base64';

import type { PluginSelectedArtifactIdentity } from './artifactLease';
import { createPluginArtifactDaemonSource, type PluginArtifactDaemonByteFetcher } from './artifactDaemonSource';
import { createPluginAccountAvailabilityReaderStore } from './reader';
import { PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { DaemonPluginUiArtifactBytesReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

const digest = `sha256:${'a'.repeat(64)}` as const;
const transport = { machineId: 'machine-a', serverId: 'server-a' } as const;
const alternateTransport = { machineId: 'machine-b', serverId: 'server-a' } as const;
const artifact: PluginSelectedArtifactIdentity = Object.freeze({
    pluginId: 'acme.preview',
    contributionId: 'preview',
    artifactId: 'preview-artifact',
    tier: 'hostedWeb',
    platform: 'web',
    digest,
    hostUiApiRange: '^1.0.0',
    releaseVersion: '1.0.0',
});
const entryBytes = new Uint8Array([104, 105]);

function okResponse(family: 'hostedWeb' | 'reactNative', responseDigest: string = digest) {
    return {
        ok: true as const,
        artifactFamily: family,
        cacheIdentity: { artifactDigest: responseDigest },
        artifact: family === 'hostedWeb'
            ? { artifactKind: 'hostedWebAsset' as const, digest: responseDigest, byteSize: entryBytes.byteLength }
            : {
                artifactKind: 'reactNativeBundle' as const,
                digest: responseDigest,
                format: 'plainJs' as const,
                byteSize: entryBytes.byteLength,
            },
        files: [{
            relativePath: 'index.html',
            digest: `sha256:${'b'.repeat(64)}`,
            byteSize: entryBytes.byteLength,
            bytesBase64: encodeBase64(entryBytes),
        }],
    };
}

describe('daemon Artifact byte source', () => {
    beforeEach(() => guardedMachineRpc.mockReset());

    it('uses all exact byte advertisements only within the captured Account Home', async () => {
        const scope = { serverId: 'captured-home', accountId: 'owner' };
        const selectedArtifact = { ...artifact, tier: 'reactNative' as const };
        const materialization = PluginMachineMaterializationV1Schema.parse({ serverIdentityId: 'srv_advertised_identity',
            machineId: 'first-supplier', materializationId: 'installation', pluginId: artifact.pluginId,
            version: '0.9.0', sourceClass: 'versionedArchive', portableRelease: true,
            archiveDigestSha256: `sha256:${'f'.repeat(64)}`, enabled: false, trustState: 'untrusted', observedAt: 1,
            uiArtifacts: [{ contributionId: artifact.contributionId, artifactId: artifact.artifactId, tier: selectedArtifact.tier,
                platform: artifact.platform, artifactDigest: artifact.digest, hostUiApiRange: artifact.hostUiApiRange }] });
        const advertisement = materialization.uiArtifacts[0]!;
        const materializations = [materialization,
            { ...materialization, machineId: 'wrong-plugin', pluginId: 'other.plugin' },
            { ...materialization, machineId: 'wrong-platform', uiArtifacts: [{ ...advertisement, platform: 'ios' as const }] },
            { ...materialization, machineId: 'wrong-digest', uiArtifacts: [{ ...advertisement, artifactDigest: `sha256:${'e'.repeat(64)}` as const }] },
            { ...materialization, machineId: 'second-supplier', serverIdentityId: 'srv_foreign_claim' },
        ];
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations, snapshots: [] } });
        const fetchArtifactBytes = vi.fn<PluginArtifactDaemonByteFetcher>(async () => ({ ok: false, code: 'artifact_unavailable', diagnostics: [] }));
        const source = createPluginArtifactDaemonSource({ transports: [], family: 'reactNative', fetchArtifactBytes,
            availability: { reader: store.bind(scope), serverId: scope.serverId } });
        expect(await source.fetch({ artifact: selectedArtifact })).toBeNull();
        expect(fetchArtifactBytes.mock.calls.map(([request]) => request.transport)).toEqual([
            { machineId: 'first-supplier', serverId: scope.serverId },
            { machineId: 'second-supplier', serverId: scope.serverId },
        ]);
    });

    it('keeps an explicit byte route when the Account inventory is unavailable', async () => {
        const store = createPluginAccountAvailabilityReaderStore();
        const fetchArtifactBytes = vi.fn<PluginArtifactDaemonByteFetcher>(async () => DaemonPluginUiArtifactBytesReadResponseSchema.parse(okResponse('hostedWeb')));
        const source = createPluginArtifactDaemonSource({ transport, family: 'hostedWeb', fetchArtifactBytes,
            availability: { reader: store.bind({ serverId: 'missing-home', accountId: 'owner' }), serverId: transport.serverId } });
        expect(await source.fetch({ artifact })).toEqual(new Map([['index.html', entryBytes]]));
        expect(fetchArtifactBytes).toHaveBeenCalledWith(expect.objectContaining({ transport }));
    });

    it('cancels a held daemon byte read when its acquisition retires', async () => {
        const lifetime = new AbortController();
        // The fetcher is the machine byte transport boundary; source decoding
        // and the supplied acquisition cancellation remain real.
        const source = createPluginArtifactDaemonSource({
            transport,
            family: 'hostedWeb',
            fetchArtifactBytes: ({ signal }) => new Promise((resolve) => {
                signal?.addEventListener('abort', () => resolve({
                    ok: false, code: 'artifact_unavailable', diagnostics: [],
                }), { once: true });
            }),
        });
        let result: Awaited<ReturnType<typeof source.fetch>> | undefined;
        void source.fetch({ artifact, signal: lifetime.signal }).then((value) => { result = value; });
        lifetime.abort();
        await vi.waitFor(() => expect(result).toBeNull());
    });

    it.each(['hostedWeb', 'reactNative'] as const)(
        'asks the selected machine for the %s file set by digest only',
        async (family) => {
            guardedMachineRpc.mockResolvedValueOnce(okResponse(family));
            const source = createPluginArtifactDaemonSource({ transport, family });

            await expect(source.fetch({ artifact })).resolves.toEqual(new Map([['index.html', entryBytes]]));
            expect(source.kind).toBe('daemon');
            expect(guardedMachineRpc).toHaveBeenCalledWith({
                machineId: 'machine-a',
                serverId: 'server-a',
                method: RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
                operationTimeoutMs: null,
                payload: {
                    artifactFamily: family,
                    machineId: 'machine-a',
                    cacheIdentity: { artifactDigest: digest },
                },
            });
        },
    );

    it('distinguishes byte misses from a missing daemon route or a failed transport', async () => {
        const source = createPluginArtifactDaemonSource({ transport, family: 'hostedWeb' });
        guardedMachineRpc.mockResolvedValueOnce(okResponse('hostedWeb', `sha256:${'c'.repeat(64)}`));
        await expect(source.fetch({ artifact })).resolves.toBeNull();
        guardedMachineRpc.mockResolvedValueOnce(okResponse('reactNative'));
        await expect(source.fetch({ artifact })).resolves.toBeNull();
        guardedMachineRpc.mockResolvedValueOnce({ ok: false, code: 'artifact_unavailable', diagnostics: [] });
        await expect(source.fetch({ artifact })).resolves.toBeNull();
        guardedMachineRpc.mockResolvedValueOnce({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'unsupported' });
        await expect(source.fetch({ artifact })).rejects.toMatchObject({ code: 'artifact_bytes_rpc_unavailable' });
        guardedMachineRpc.mockRejectedValueOnce(new Error('offline'));
        await expect(source.fetch({ artifact })).rejects.toMatchObject({ code: 'artifact_bytes_fetch_failed' });
    });

    it.each([
        { ok: false, code: 'artifact_unavailable', diagnostics: [] },
        { errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'unsupported' },
        okResponse('hostedWeb', `sha256:${'c'.repeat(64)}`),
    ])('reads the selected digest from another admitted source after a miss or refusal (%j)', async (firstResponse) => {
        guardedMachineRpc.mockResolvedValueOnce(firstResponse).mockResolvedValueOnce(okResponse('hostedWeb'));
        const source = createPluginArtifactDaemonSource({
            transports: [transport, alternateTransport],
            family: 'hostedWeb',
        });

        await expect(source.fetch({ artifact })).resolves.toEqual(new Map([['index.html', entryBytes]]));
        expect(guardedMachineRpc.mock.calls.map(([request]) => ({
            machineId: request.machineId,
            cacheIdentity: request.payload.cacheIdentity,
        }))).toEqual([
            { machineId: transport.machineId, cacheIdentity: { artifactDigest: digest } },
            { machineId: alternateTransport.machineId, cacheIdentity: { artifactDigest: digest } },
        ]);
    });

    it('stops the admitted source walk when the acquisition is cancelled', async () => {
        const lifetime = new AbortController();
        const fetchArtifactBytes = vi.fn(async () => {
            lifetime.abort();
            return { ok: false as const, code: 'artifact_unavailable' as const, diagnostics: [] };
        });
        const source = createPluginArtifactDaemonSource({
            transports: [transport, alternateTransport],
            family: 'hostedWeb',
            fetchArtifactBytes,
        });

        await expect(source.fetch({ artifact, signal: lifetime.signal })).resolves.toBeNull();
        expect(fetchArtifactBytes).toHaveBeenCalledTimes(1);
    });

    it('asks each exact Home and Machine route once when suppliers repeat', async () => {
        guardedMachineRpc.mockResolvedValue({ ok: false, code: 'artifact_unavailable', diagnostics: [] });
        const otherHomeTransport = { ...transport, serverId: 'server-b' };
        const source = createPluginArtifactDaemonSource({
            transports: [transport, { ...transport }, alternateTransport, otherHomeTransport],
            family: 'hostedWeb',
        });

        await expect(source.fetch({ artifact })).resolves.toBeNull();
        expect(guardedMachineRpc.mock.calls.map(([request]) => ({
            serverId: request.serverId, machineId: request.machineId,
        }))).toEqual([transport, alternateTransport, otherHomeTransport]);
    });

    it('retains a safe transport failure when every admitted source misses', async () => {
        guardedMachineRpc.mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({ ok: false, code: 'artifact_unavailable', diagnostics: [] });
        const source = createPluginArtifactDaemonSource({
            transports: [transport, alternateTransport],
            family: 'hostedWeb',
        });

        await expect(source.fetch({ artifact })).rejects.toMatchObject({ code: 'artifact_bytes_fetch_failed' });
        expect(guardedMachineRpc).toHaveBeenCalledTimes(2);
    });
});
