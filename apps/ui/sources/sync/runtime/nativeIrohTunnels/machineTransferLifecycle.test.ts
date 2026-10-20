import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeBoundary = vi.hoisted(() => ({
    current: null as Record<string, unknown> | null,
    ensureApplicationEndpoint: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        AppState: {
            currentState: 'active',
            addEventListener: () => ({ remove: () => undefined }),
        },
    });
});

vi.mock('@happier-dev/iroh-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/iroh-native')>();
    return {
        ...actual,
        getOptionalHappierIrohNativeModule: () => nativeBoundary.current,
        ensureIrohApplicationEndpoint: (...args: unknown[]) => nativeBoundary.ensureApplicationEndpoint(...args),
    };
});

import { AppState } from 'react-native';
import {
    getIrohApplicationEndpoint,
    isIrohMachineTransferLifecycleAvailable,
    probeIrohMachineTransferLifecycleAvailability,
    readRetainedIrohMachineTransferLeaseIds,
    releaseRetainedIrohMachineTransferLeases,
    irohMachineTransferRuntimeActivity,
    startIrohMachineTransferTunnel,
    startIrohMachineHttpTunnel,
} from './machineTransferLifecycle';

const ENDPOINT_ID = 'b'.repeat(64);

function setRuntimeAppState(state: string): void {
    (AppState as unknown as { currentState: string }).currentState = state;
}

describe('machine Iroh lifecycle availability and application endpoint ownership', () => {
    const originalInternals = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    const originalNavigator = (globalThis as Record<string, unknown>).navigator;

    beforeEach(() => {
        setRuntimeAppState('active');
        nativeBoundary.current = null;
        nativeBoundary.ensureApplicationEndpoint.mockReset();
        delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
        (globalThis as Record<string, unknown>).navigator = { userAgent: 'test-mobile' };
    });

    afterEach(() => {
        if (originalInternals === undefined) delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
        else (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = originalInternals;
        (globalThis as Record<string, unknown>).navigator = originalNavigator;
    });

    it('reports mobile unavailable when the registered module engine is absent', async () => {
        nativeBoundary.current = {
            getAvailability: () => ({ available: false }),
            createEndpoint: vi.fn(),
            startMachineTunnel: vi.fn(),
            stopMachineTunnel: vi.fn(),
        };
        expect(isIrohMachineTransferLifecycleAvailable()).toBe(false);
        await expect(probeIrohMachineTransferLifecycleAvailability()).resolves.toBe(false);
    });

    it.each([
        ['electron', false],
        ['tauri', true],
    ] as const)('probes the real %s host availability command before selection', async (hostKind, available) => {
        const invoke = vi.fn(async (command: string) => {
            expect(command).toBe('iroh_get_availability');
            return { available };
        });
        (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
        (globalThis as Record<string, unknown>).navigator = {
            userAgent: hostKind === 'electron' ? 'Electron/43.4.0' : 'Tauri/2.0',
        };

        expect(isIrohMachineTransferLifecycleAvailable()).toBe(false);
        await expect(probeIrohMachineTransferLifecycleAvailability()).resolves.toBe(available);
        expect(isIrohMachineTransferLifecycleAvailable()).toBe(available);
    });

    it('uses the shared mobile application endpoint owner for machine identity and tunnel startup', async () => {
        const native = {
            getAvailability: () => ({ available: true }),
            createEndpoint: vi.fn(),
            startMachineTunnel: vi.fn(async () => ({
                machineTunnelId: 'machine-1',
                localPort: 48123,
            })),
            stopMachineTunnel: vi.fn(async () => undefined),
        };
        nativeBoundary.current = native;
        nativeBoundary.ensureApplicationEndpoint.mockResolvedValue({
            endpointHandle: 'shared-mobile-endpoint',
            endpointId: ENDPOINT_ID,
        });

        await expect(getIrohApplicationEndpoint({
            policy: 'disabled',
            relayUrls: [],
        })).resolves.toEqual({ endpointId: ENDPOINT_ID });
        const lease = await startIrohMachineTransferTunnel({
            policy: 'disabled',
            endpointId: 'a'.repeat(64),
            directAddresses: ['127.0.0.1:48124'],
            relayUrls: [],
            handshakeJson: '{}',
        });

        expect(lease).toEqual({
            leaseId: 'machine-1',
            localOrigin: 'http://127.0.0.1:48123',
            release: expect.any(Function),
        });

        expect(nativeBoundary.ensureApplicationEndpoint).toHaveBeenCalledTimes(2);
        expect(nativeBoundary.ensureApplicationEndpoint).toHaveBeenNthCalledWith(1, native, {
            policy: 'disabled',
            relayUrls: [],
        });
        expect(nativeBoundary.ensureApplicationEndpoint).toHaveBeenNthCalledWith(2, native, {
            policy: 'disabled',
            relayUrls: [],
        });
        expect(native.startMachineTunnel).toHaveBeenCalledWith(expect.objectContaining({
            endpointHandle: 'shared-mobile-endpoint',
            capProfile: 'machineBulk',
        }));
    });

    it('keeps preview mux authorization native and releases the guest listener on suspension', async () => {
        let close: () => void = () => undefined;
        const terminal = new Promise<void>((resolve) => { close = resolve; });
        const native = {
            getAvailability: () => ({ available: true }),
            createEndpoint: vi.fn(),
            startMachineTunnel: vi.fn(async () => ({ machineTunnelId: 'preview-lease', localPort: 48127 })),
            stopMachineTunnel: vi.fn(async () => undefined),
            waitMachineTunnelClosed: vi.fn(() => terminal),
        };
        nativeBoundary.current = native;
        nativeBoundary.ensureApplicationEndpoint.mockResolvedValue({ endpointHandle: 'shared-mobile-endpoint', endpointId: ENDPOINT_ID });
        const nativeHttpLease = { openJson: '{"signed":"preview-mux-open"}' };
        const lease = await startIrohMachineTransferTunnel({
            endpointId: 'a'.repeat(64), handshakeJson: '{}', nativeHttpLease,
        });
        expect(native.startMachineTunnel).toHaveBeenCalledWith(expect.objectContaining({ nativeHttpLease }));
        expect(lease.localOrigin).toBe('http://127.0.0.1:48127');
        expect(lease).not.toHaveProperty('requestHeaders');
        expect(lease).not.toHaveProperty('webSocketProtocols');
        let closed = false;
        void lease.closed?.then(() => { closed = true; });
        await Promise.resolve();
        expect(closed).toBe(false);
        close();
        await lease.closed;
        expect(closed).toBe(true);
        irohMachineTransferRuntimeActivity.markSuspended();
        await lease.release();
        expect(native.stopMachineTunnel).toHaveBeenCalledWith('preview-lease');
    });

    it('uses the raw Tauri machine tunnel command without projecting a local bearer', async () => {
        const invoke = vi.fn(async (command: string) => {
            if (command === 'iroh_start_machine_tunnel') {
                return { leaseId: 'machine-desktop-1', localPort: 48126 };
            }
            if (command === 'iroh_stop_machine_tunnel') return null;
            throw new Error(`unexpected command: ${command}`);
        });
        (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
        (globalThis as Record<string, unknown>).navigator = { userAgent: 'Tauri/2.0' };

        const lease = await startIrohMachineTransferTunnel({
            endpointId: 'a'.repeat(64),
            handshakeJson: '{}',
        });
        expect(lease).toMatchObject({
            leaseId: 'machine-desktop-1',
            localOrigin: 'http://127.0.0.1:48126',
        });
        expect(lease).not.toHaveProperty('requestHeaders');
        expect(invoke).toHaveBeenCalledWith('iroh_start_machine_tunnel', expect.anything());
        await lease.release();
        expect(invoke).toHaveBeenCalledWith('iroh_stop_machine_tunnel', { leaseId: 'machine-desktop-1' });
    });

    it('owns a capability-gated HTTP lease and retires it with the shared app lifecycle', async () => {
        const capability = 'c'.repeat(64);
        const stopped: string[] = [];
        nativeBoundary.current = {
            getAvailability: () => ({ available: true }),
            createEndpoint: vi.fn(),
            startMachineTunnel: vi.fn(async () => { throw new Error('raw carrier cannot serve HTTP'); }),
            startMachineHttpTunnel: async () => ({ machineTunnelId: 'http-mobile-1', localPort: 48127, localCapability: capability }),
            stopMachineTunnel: async (leaseId: string) => { stopped.push(leaseId); },
        };
        nativeBoundary.ensureApplicationEndpoint.mockResolvedValue({ endpointHandle: 'shared-mobile-endpoint', endpointId: ENDPOINT_ID });

        // The native module is the genuine process boundary; the lifecycle and
        // its suspension/cleanup custody run unchanged beneath it.
        const lease = await startIrohMachineHttpTunnel({ endpointId: 'a'.repeat(64), handshakeJson: '{}' });
        expect(lease.localOrigin).toBe('http://127.0.0.1:48127');
        expect(lease.requestHeaders).toEqual({ 'x-happier-machine-local-capability': capability });
        expect(lease.webSocketProtocols).toEqual([`happier.iroh.cap.${capability}`]);
        expect(lease.localOrigin).not.toContain(capability);

        irohMachineTransferRuntimeActivity.markSuspended();
        await lease.release();
        expect(stopped).toEqual(['http-mobile-1']);
        expect(readRetainedIrohMachineTransferLeaseIds()).toEqual([]);
    });
});

describe('machine Iroh finite-transfer listener cleanup custody', () => {
    const originalNavigator = (globalThis as Record<string, unknown>).navigator;

    function mountMobileNative(input: Readonly<{
        stopMachineTunnel: (leaseId: string) => Promise<void>;
        startMachineTunnel?: () => Promise<Readonly<{
            machineTunnelId: string;
            localPort: number;
            localCapability?: string;
        }>>;
    }>) {
        let startedTunnels = 0;
        const native = {
            getAvailability: () => ({ available: true }),
            createEndpoint: vi.fn(),
            startMachineTunnel: vi.fn(input.startMachineTunnel ?? (async () => {
                startedTunnels += 1;
                return {
                    machineTunnelId: `machine-${startedTunnels}`,
                    localPort: 48_122 + startedTunnels,
                };
            })),
            stopMachineTunnel: vi.fn(input.stopMachineTunnel),
        };
        nativeBoundary.current = native;
        nativeBoundary.ensureApplicationEndpoint.mockResolvedValue({
            endpointHandle: 'shared-mobile-endpoint',
            endpointId: ENDPOINT_ID,
        });
        return native;
    }

    async function startLease() {
        return await startIrohMachineTransferTunnel({
            endpointId: 'a'.repeat(64),
            handshakeJson: '{}',
        });
    }

    beforeEach(() => {
        setRuntimeAppState('active');
        nativeBoundary.current = null;
        nativeBoundary.ensureApplicationEndpoint.mockReset();
        delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
        (globalThis as Record<string, unknown>).navigator = { userAgent: 'test-mobile' };
    });

    afterEach(async () => {
        await releaseRetainedIrohMachineTransferLeases().catch(() => undefined);
        (globalThis as Record<string, unknown>).navigator = originalNavigator;
    });

    it('retains a lease whose native stop failed and retries it on a later release', async () => {
        let stopAttempts = 0;
        const native = mountMobileNative({
            stopMachineTunnel: async () => {
                stopAttempts += 1;
                if (stopAttempts === 1) throw new Error('native machine tunnel stop failed');
            },
        });

        const lease = await startLease();
        await expect(lease.release()).rejects.toThrow('native machine tunnel stop failed');
        expect(native.stopMachineTunnel).toHaveBeenCalledTimes(1);
        expect(readRetainedIrohMachineTransferLeaseIds()).toEqual([lease.leaseId]);

        await expect(lease.release()).resolves.toBeUndefined();
        expect(native.stopMachineTunnel).toHaveBeenCalledTimes(2);
        expect(readRetainedIrohMachineTransferLeaseIds()).toEqual([]);

        // A released lease is no longer owned, so a redundant release is inert.
        await lease.release();
        expect(native.stopMachineTunnel).toHaveBeenCalledTimes(2);
    });

    it('coalesces concurrent releases of one lease into a single native stop', async () => {
        let releaseStop!: () => void;
        const stopGate = new Promise<void>((resolve) => {
            releaseStop = resolve;
        });
        const native = mountMobileNative({ stopMachineTunnel: async () => await stopGate });

        const lease = await startLease();
        const first = lease.release();
        const second = lease.release();
        releaseStop();
        await Promise.all([first, second]);

        expect(native.stopMachineTunnel).toHaveBeenCalledTimes(1);
        expect(readRetainedIrohMachineTransferLeaseIds()).toEqual([]);
    });

    it('releases an active finite-transfer lease when the canonical app lifecycle suspends', async () => {
        const native = mountMobileNative({ stopMachineTunnel: async () => undefined });
        const lease = await startLease();

        irohMachineTransferRuntimeActivity.markSuspended();

        await vi.waitFor(() => expect(native.stopMachineTunnel).toHaveBeenCalledWith(lease.leaseId));
        await lease.release();
        expect(native.stopMachineTunnel).toHaveBeenCalledTimes(1);
    });

    it('releases a mobile lease that arrives after the shared runtime becomes inactive', async () => {
        let finishStart!: (value: Readonly<{ machineTunnelId: string; localPort: number }>) => void;
        const native = mountMobileNative({
            startMachineTunnel: async () => await new Promise((resolve) => {
                finishStart = resolve;
            }),
            stopMachineTunnel: async () => undefined,
        });

        const starting = startLease();
        await vi.waitFor(() => expect(native.startMachineTunnel).toHaveBeenCalledTimes(1));

        setRuntimeAppState('background');
        irohMachineTransferRuntimeActivity.markSuspended();
        finishStart({ machineTunnelId: 'late-machine-lease', localPort: 48_130 });

        await expect(starting).rejects.toMatchObject({
            name: 'IrohError',
            code: 'unavailable',
            message: 'iroh_home_tunnel_suspended',
        });
        expect(native.stopMachineTunnel).toHaveBeenCalledWith('late-machine-lease');
        expect(readRetainedIrohMachineTransferLeaseIds()).toEqual([]);
    });

    it('refuses mobile acquisition while the shared runtime is already inactive', async () => {
        const native = mountMobileNative({ stopMachineTunnel: async () => undefined });
        setRuntimeAppState('background');

        await expect(startLease()).rejects.toMatchObject({
            name: 'IrohError',
            code: 'unavailable',
            message: 'iroh_home_tunnel_suspended',
        });
        expect(nativeBoundary.ensureApplicationEndpoint).not.toHaveBeenCalled();
        expect(native.startMachineTunnel).not.toHaveBeenCalled();
    });

    it('retries a retained lease when the next machine tunnel is started', async () => {
        let stopAttempts = 0;
        const native = mountMobileNative({
            stopMachineTunnel: async () => {
                stopAttempts += 1;
                if (stopAttempts === 1) throw new Error('native machine tunnel stop failed');
            },
        });

        const first = await startLease();
        await expect(first.release()).rejects.toThrow('native machine tunnel stop failed');
        expect(readRetainedIrohMachineTransferLeaseIds()).toEqual([first.leaseId]);

        const second = await startLease();

        expect(native.stopMachineTunnel).toHaveBeenNthCalledWith(2, first.leaseId);
        expect(readRetainedIrohMachineTransferLeaseIds()).toEqual([]);
        // The retry never disturbs the lease the new transfer just acquired.
        expect(second.leaseId).not.toBe(first.leaseId);
        expect(native.stopMachineTunnel).toHaveBeenCalledTimes(2);

        await second.release();
        expect(native.stopMachineTunnel).toHaveBeenCalledTimes(3);
    });

    it('rejects a new start when retained cleanup still fails', async () => {
        let stopAttempts = 0;
        const native = mountMobileNative({
            stopMachineTunnel: async () => {
                stopAttempts += 1;
                if (stopAttempts <= 2) throw new Error('native machine tunnel stop still failing');
            },
        });

        const first = await startLease();
        await expect(first.release()).rejects.toThrow('native machine tunnel stop still failing');

        await expect(startLease()).rejects.toThrow('native machine tunnel stop still failing');
        expect(native.stopMachineTunnel).toHaveBeenCalledTimes(2);
        expect(native.startMachineTunnel).toHaveBeenCalledTimes(1);
        expect(readRetainedIrohMachineTransferLeaseIds()).toEqual([first.leaseId]);
    });

    it('takes cleanup custody when native returns a lease id with malformed connection facts', async () => {
        let stopAttempts = 0;
        const native = mountMobileNative({
            startMachineTunnel: async () => ({
                machineTunnelId: 'malformed-machine-lease',
                localPort: 0,
            }),
            stopMachineTunnel: async () => {
                stopAttempts += 1;
                if (stopAttempts === 1) throw new Error('malformed lease stop failed');
            },
        });

        await expect(startLease()).rejects.toThrow('Iroh machine transfer lease returned an invalid local origin');
        expect(native.stopMachineTunnel).toHaveBeenCalledWith('malformed-machine-lease');
        expect(readRetainedIrohMachineTransferLeaseIds()).toEqual(['malformed-machine-lease']);

        const { disposeIrohHomeTunnelRuntime } = await import('./runtime');
        await disposeIrohHomeTunnelRuntime();
        expect(native.stopMachineTunnel).toHaveBeenCalledTimes(2);
        expect(readRetainedIrohMachineTransferLeaseIds()).toEqual([]);
    });

    it('rejects a stale capability-bearing raw tunnel and releases its native handle', async () => {
        const native = mountMobileNative({
            startMachineTunnel: async () => ({
                machineTunnelId: 'stale-capability-machine-lease',
                localPort: 48_129,
                localCapability: 'c'.repeat(64),
            }),
            stopMachineTunnel: async () => undefined,
        });

        await expect(startLease()).rejects.toThrow('unexpected local capability');
        expect(native.stopMachineTunnel).toHaveBeenCalledWith('stale-capability-machine-lease');
        expect(readRetainedIrohMachineTransferLeaseIds()).toEqual([]);
    });
});
