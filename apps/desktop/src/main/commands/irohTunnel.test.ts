import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { ElectronIrohTunnelService, IROH_ENDPOINT_KEY_RELPATH } from './irohTunnel';

const ENDPOINT_ID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const USER_DATA = join('/happier-test', 'desktop-user-data');
const CANONICAL_KEY_PATH = join(USER_DATA, ...IROH_ENDPOINT_KEY_RELPATH);

function createNativeFake() {
    const calls = {
        create: [] as unknown[],
        start: [] as unknown[],
        stop: [] as string[],
        shutdown: [] as string[],
        status: [] as string[],
        machineStart: [] as unknown[],
        machineRawStart: [] as unknown[],
        machineStop: [] as string[],
    };
    const native = {
        createEndpoint: async (request: unknown) => {
            calls.create.push(request);
            return { endpointHandle: CANONICAL_KEY_PATH, endpointId: 'client-endpoint' };
        },
        ensureHomeTunnel: async (request: {
            endpointHandle: string;
            homeServerIdentityId: string;
            endpointId: string;
        }) => {
            calls.start.push(request);
            return {
                tunnelId: 'iroh-lease-1',
                homeServerIdentityId: request.homeServerIdentityId,
                homeEndpointId: request.endpointId,
                runtimeOrigin: 'http://127.0.0.1:46011',
                carrier: 'iroh' as const,
                observedPath: 'direct' as const,
                startedAtMs: 42,
                // The keyed endpoint handle is the canonical key path; it must
                // never reach the renderer.
                endpointHandle: request.endpointHandle,
            };
        },
        releaseHomeTunnel: async (leaseId: string) => {
            calls.stop.push(leaseId);
        },
        getTunnelStatus: async (tunnelId: string) => {
            calls.status.push(tunnelId);
            return { active: false, connectionActive: false, observedPath: 'relay' };
        },
        shutdownEndpoint: async (request: { endpointHandle: string }) => {
            calls.shutdown.push(request.endpointHandle);
        },
        startMachineHttpTunnel: async (request: unknown) => {
            calls.machineStart.push(request);
            return { machineTunnelId: 'machine-lease-1', localPort: 46012, localCapability: 'a'.repeat(64) };
        },
        startMachineTunnel: async (request: { handshakeJson: string }) => {
            calls.machineRawStart.push(request);
            const flow = (JSON.parse(request.handshakeJson) as { flow?: string }).flow;
            return {
                machineTunnelId: `machine-${flow ?? 'unknown'}-lease`,
                localPort: flow === 'finite_transfer' ? 46013 : 46014,
                ...(flow === 'workspace_sync' ? { localCapability: 'b'.repeat(64) } : {}),
            };
        },
        stopMachineTunnel: async (leaseId: string) => {
            calls.machineStop.push(leaseId);
        },
    };
    return { native, calls };
}

function createService(native: unknown): ElectronIrohTunnelService {
    return new ElectronIrohTunnelService({
        userDataPath: () => USER_DATA,
        loadNative: async () => (native === null ? null : (native as never)),
    });
}

test('start injects the host-owned persistent key path and returns only renderer lease facts', async () => {
    const { native, calls } = createNativeFake();
    const service = createService(native);

    const lease = await service.ensureHomeTunnel({
        homeServerIdentityId: 'srv_home_a',
        endpointId: ENDPOINT_ID,
        policy: 'automatic',
        relayUrls: ['https://relay.example.test'],
        directAddresses: ['192.168.1.10:4242'],
        // Renderer-supplied identity material must never reach the native request.
        endpointKeyPath: '/tmp/renderer.key',
        endpointSeedBase64: 'AAAA',
    });

    assert.deepEqual(calls.create, [{
        keyPath: CANONICAL_KEY_PATH,
        relayPolicy: 'automatic',
        relayUrls: ['https://relay.example.test'],
    }]);
    assert.deepEqual(calls.start, [
        {
            endpointHandle: CANONICAL_KEY_PATH,
            homeServerIdentityId: 'srv_home_a',
            endpointId: ENDPOINT_ID,
            relayUrls: ['https://relay.example.test'],
            directAddresses: ['192.168.1.10:4242'],
        },
    ]);
    assert.deepEqual(lease, {
        leaseId: 'iroh-lease-1',
        homeServerIdentityId: 'srv_home_a',
        homeEndpointId: ENDPOINT_ID,
        runtimeOrigin: 'http://127.0.0.1:46011',
        carrier: 'iroh',
        observedPath: 'direct',
        startedAtMs: 42,
    });
});

test('Home-first and machine-first configurations retain one application EndpointId', async () => {
    for (const first of ['home', 'machine'] as const) {
        const { native, calls } = createNativeFake();
        const service = createService(native);
        const directOnly = { policy: 'disabled' as const, relayUrls: [] as const };

        if (first === 'home') {
            await service.ensureHomeTunnel({
                homeServerIdentityId: 'srv_home_a', endpointId: ENDPOINT_ID, ...directOnly,
                directAddresses: ['127.0.0.1:4242'],
            });
        }
        const endpoint = await service.getApplicationEndpoint(directOnly);
        if (first === 'machine') {
            await service.ensureHomeTunnel({
                homeServerIdentityId: 'srv_home_a', endpointId: ENDPOINT_ID, ...directOnly,
                directAddresses: ['127.0.0.1:4242'],
            });
        }

        assert.equal(endpoint.endpointId, 'client-endpoint');
        assert.ok(calls.create.length >= 2);
        assert.deepEqual(new Set(calls.create.map(() => endpoint.endpointId)), new Set(['client-endpoint']));
        assert.ok(calls.create.every((request) => (
            request as { relayPolicy?: unknown }
        ).relayPolicy === 'disabled'));
    }
});

test('production automatic plus empty relay configuration is order-independent for Home and machine', async () => {
    for (const first of ['home', 'machine'] as const) {
        const { native, calls } = createNativeFake();
        const service = createService(native);
        if (first === 'home') {
            await service.ensureHomeTunnel({
                homeServerIdentityId: 'srv_home_a', endpointId: ENDPOINT_ID, policy: 'automatic', relayUrls: [],
            });
        } else {
            await service.getApplicationEndpoint({});
        }
        if (first === 'home') await service.getApplicationEndpoint({});
        else {
            await service.ensureHomeTunnel({
                homeServerIdentityId: 'srv_home_a', endpointId: ENDPOINT_ID, policy: 'automatic', relayUrls: [],
            });
        }
        assert.equal(calls.create.length, 2);
        assert.ok(calls.create.every((request) => (
            request as { relayPolicy?: unknown }
        ).relayPolicy === 'automatic'));
    }
});

test('automatic Home and machine requests contribute relay sets through one endpoint owner', async () => {
    const { native, calls } = createNativeFake();
    const service = createService(native);

    await service.getApplicationEndpoint({ policy: 'automatic', relayUrls: ['https://relay-machine.example.test'] });
    await service.ensureHomeTunnel({
        homeServerIdentityId: 'srv_home_a', endpointId: ENDPOINT_ID, policy: 'automatic',
        relayUrls: ['https://relay-home.example.test'],
    });

    assert.deepEqual(calls.create, [
        {
            keyPath: CANONICAL_KEY_PATH,
            relayPolicy: 'automatic',
            relayUrls: ['https://relay-machine.example.test'],
        },
        {
            keyPath: CANONICAL_KEY_PATH,
            relayPolicy: 'automatic',
            relayUrls: ['https://relay-home.example.test'],
        },
    ]);
});

test('availability is false unless the Electron lifecycle addon actually loads', async () => {
    await assert.deepEqual(await createService(null).getAvailability(), { available: false });
    const { native } = createNativeFake();
    await assert.deepEqual(await createService(native).getAvailability(), { available: true });
});

test('status polling returns only transport facts and keeps host identity material private', async () => {
    const { native, calls } = createNativeFake();
    const service = createService(native);

    assert.deepEqual(await service.getTunnelStatus('iroh-lease-1'), {
        active: false,
        connectionActive: false,
        observedPath: 'relay',
    });
    assert.deepEqual(calls.status, ['iroh-lease-1']);
});

test('stop routes by lease and process shutdown closes the endpoint without touching identity', async () => {
    const { native, calls } = createNativeFake();
    const service = createService(native);

    await service.ensureHomeTunnel({ homeServerIdentityId: 'srv_home_a', endpointId: ENDPOINT_ID, policy: 'automatic' });
    await service.releaseHomeTunnel('iroh-lease-1');
    assert.deepEqual(calls.stop, ['iroh-lease-1']);

    // Nothing to shut down before a start: the addon is not even loaded.
    const idleService = createService(native);
    await idleService.shutdownForProcessExit();
    assert.deepEqual(calls.shutdown, []);

    await service.shutdownForProcessExit();
    assert.deepEqual(calls.shutdown, [CANONICAL_KEY_PATH]);
    // A second shutdown is a no-op (the handle was consumed).
    await service.shutdownForProcessExit();
    assert.deepEqual(calls.shutdown, [CANONICAL_KEY_PATH]);
});

test('native unavailability and native failures reject without ever succeeding', async () => {
    const unavailable = createService(null);
    await assert.rejects(
        unavailable.ensureHomeTunnel({ homeServerIdentityId: 'srv_home_a', endpointId: ENDPOINT_ID, policy: 'automatic' }),
        (error: Error) => error.message.startsWith('iroh_native_error:unavailable:'),
    );
    await assert.rejects(
        unavailable.releaseHomeTunnel('lease'),
        (error: Error) => error.message.startsWith('iroh_native_error:unavailable:'),
    );

    const { native } = createNativeFake();
    const failing = {
        ...native,
        ensureHomeTunnel: async () => {
            throw Object.assign(new Error('endpointId is invalid'), { name: 'IrohNativeOperationError', nativeCode: 'endpoint-identity-invalid' });
        },
    };
    const service = createService(failing);
    await assert.rejects(
        service.ensureHomeTunnel({ homeServerIdentityId: 'srv_home_a', endpointId: 'bad', policy: 'automatic' }),
        (error: Error) => error.message === 'iroh_native_error:endpoint-identity-invalid:endpointId is invalid',
    );
});

test('malformed native results fail closed instead of being adopted', async () => {
    const { native } = createNativeFake();
    const malformed = {
        ...native,
        ensureHomeTunnel: async () => ({ tunnelId: 'iroh-lease-1' }),
    };
    const service = createService(malformed);
    await assert.rejects(
        service.ensureHomeTunnel({ homeServerIdentityId: 'srv_home_a', endpointId: ENDPOINT_ID, policy: 'automatic' }),
        (error: Error) => error.message.startsWith('iroh_native_error:transport-unavailable:malformed native lease field'),
    );

    const externalOrigin = {
        ...native,
        ensureHomeTunnel: async () => ({
            ...(await native.ensureHomeTunnel({
                endpointHandle: CANONICAL_KEY_PATH,
                homeServerIdentityId: 'srv_home_a',
                endpointId: ENDPOINT_ID,
            })),
            runtimeOrigin: 'https://attacker.example.test',
        }),
    };
    await assert.rejects(
        createService(externalOrigin).ensureHomeTunnel({ homeServerIdentityId: 'srv_home_a', endpointId: ENDPOINT_ID, policy: 'automatic' }),
        (error: Error) => error.message.startsWith('iroh_native_error:transport-unavailable:malformed native lease field runtimeOrigin'),
    );

    const invalidObservedPath = {
        ...native,
        ensureHomeTunnel: async () => ({
            ...(await native.ensureHomeTunnel({
                endpointHandle: CANONICAL_KEY_PATH,
                homeServerIdentityId: 'srv_home_a',
                endpointId: ENDPOINT_ID,
            })),
            observedPath: 'maybe',
        }),
    };
    await assert.rejects(
        createService(invalidObservedPath).ensureHomeTunnel({ homeServerIdentityId: 'srv_home_a', endpointId: ENDPOINT_ID, policy: 'automatic' }),
        (error: Error) => error.message.startsWith('iroh_native_error:transport-unavailable:malformed native lease field observedPath'),
    );
});

test('renderer request facts are validated fail closed before the native call', async () => {
    const { native, calls } = createNativeFake();
    const service = createService(native);

    await assert.rejects(
        service.ensureHomeTunnel({ endpointId: ENDPOINT_ID, policy: 'automatic' }),
        (error: Error) => error.message.startsWith('iroh_native_error:invalid-request:'),
    );
    await assert.rejects(
        service.ensureHomeTunnel({ homeServerIdentityId: 'srv_home_a', endpointId: ENDPOINT_ID, policy: 'relay-everything' }),
        (error: Error) => error.message.startsWith('iroh_native_error:invalid-request:'),
    );
    assert.deepEqual(calls.start, []);
});

test('finite machine tunnel exposes one opaque loopback origin without a local capability', async () => {
    const { native, calls } = createNativeFake();
    const service = createService(native);
    const handshakeJson = JSON.stringify({ v: 1, flow: 'finite_transfer' });

    const lease = await service.startMachineTunnel({
        endpointId: ENDPOINT_ID,
        handshakeJson,
        policy: 'automatic',
        relayUrls: ['https://relay.example.test'],
    });

    assert.deepEqual(calls.machineRawStart, [{
        endpointHandle: CANONICAL_KEY_PATH,
        endpointId: ENDPOINT_ID,
        relayUrls: ['https://relay.example.test'],
        handshakeJson,
        capProfile: 'machineBulk',
    }]);
    assert.deepEqual(lease, {
        leaseId: 'machine-finite_transfer-lease',
        localPort: 46013,
    });
    assert.equal('localCapability' in lease, false);
});

test('protected raw workspace and provider HTTP tunnels retain their local capabilities', async () => {
    const { native } = createNativeFake();
    const service = createService(native);
    const workspace = await service.startMachineTunnel({
        endpointId: ENDPOINT_ID,
        handshakeJson: JSON.stringify({ v: 1, flow: 'workspace_sync' }),
    });
    const provider = await service.startMachineHttpTunnel({
        endpointId: ENDPOINT_ID,
        handshakeJson: JSON.stringify({ v: 1, purpose: 'provider_broker' }),
    });

    assert.equal(workspace.localCapability, 'b'.repeat(64));
    assert.equal(provider.localCapability, 'a'.repeat(64));
});

test('native preview forwards its signed mux descriptor and observes terminal native custody', async () => {
    const { native, calls } = createNativeFake();
    let finish: () => void = () => undefined;
    const terminal = new Promise<void>((resolve) => { finish = resolve; });
    const service = createService({ ...native, waitMachineTunnelClosed: async (leaseId: string) => {
        assert.equal(leaseId, 'machine-tcp_tunnel-lease');
        await terminal;
    } });
    const nativeHttpLease = { openJson: '{"signed":"preview-mux"}' };
    const lease = await service.startMachineTunnel({
        endpointId: ENDPOINT_ID, handshakeJson: JSON.stringify({ flow: 'tcp_tunnel' }), nativeHttpLease,
    });
    assert.deepEqual((calls.machineRawStart[0] as { nativeHttpLease?: unknown }).nativeHttpLease, nativeHttpLease);
    let closed = false;
    const waiting = service.waitMachineTunnelClosed(lease.leaseId).then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    finish();
    await waiting;
    assert.equal(closed, true);
    const older = createNativeFake();
    await assert.rejects(createService(older.native).startMachineTunnel({
        endpointId: ENDPOINT_ID, handshakeJson: JSON.stringify({ flow: 'tcp_tunnel' }), nativeHttpLease,
    }), /lifecycle observation is unavailable/);
    assert.deepEqual(older.calls.machineRawStart, []);
});

test('the desktop iroh seam stays lifecycle-only: no byte or payload APIs at invoke seams', () => {
    const sources = [
        'src/main/commands/irohTunnel.ts',
        'src/main/commands/registry.ts',
        'src/preload/index.ts',
    ];
    const forbidden = ['Buffer', 'Uint8Array', 'ArrayBuffer', 'DataView', 'base64', 'atob', 'btoa', 'onTunnelBytes'];
    // The node:test script runs from the package root, so the source seam is
    // read at its authoritative location rather than the compiled copy.
    for (const relative of sources) {
        const text = readFileSync(join(process.cwd(), relative), 'utf8');
        for (const identifier of forbidden) {
            assert.doesNotMatch(text, new RegExp(`\\b${identifier}\\b`), `${relative} must not reference ${identifier}`);
        }
    }
});
