import {
    getOptionalHappierIrohNativeModule,
    ensureIrohApplicationEndpoint,
    IrohError,
    IROH_HOME_TUNNEL_SUSPENDED_ERROR,
    IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
    IROH_MACHINE_WEBSOCKET_CAPABILITY_PROTOCOL_PREFIX,
    type NativeIrohModule,
} from '@happier-dev/iroh-native';

import { desktopHostKind, invokeDesktopHost } from '@/utils/platform/desktopHost';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';

export type IrohApplicationEndpoint = Readonly<{ endpointId: string }>;
export type IrohApplicationEndpointConfiguration = Readonly<{
    policy?: 'automatic' | 'disabled';
    relayUrls?: readonly string[];
}>;
export type IrohMachineTransferNativeLease = Readonly<{
    leaseId: string;
    localOrigin: string;
    release: () => Promise<void>;
    /** Native guest mux completion; raw finite-transfer leases do not use it. */
    closed?: Promise<void>;
}>;
export type IrohMachineHttpNativeLease = IrohMachineTransferNativeLease & Readonly<{
    /** Private native-client authentication, never a guest navigation URL. */
    requestHeaders: Readonly<Record<string, string>>;
    webSocketProtocols: readonly string[];
}>;

function readEndpoint(value: unknown): IrohApplicationEndpoint {
    const endpointId = typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>).endpointId
        : null;
    if (typeof endpointId !== 'string' || !/^[0-9a-f]{64}$/u.test(endpointId)) {
        throw new Error('Iroh application endpoint is unavailable');
    }
    return { endpointId };
}

// This inventory owns every active Machine listener so app suspension
// can stop it immediately and diagnostics can name retained lease ids. The
// Home-carrier release helper owns only failed release retries, so folding this
// lifecycle inventory into that helper would erase a real foreground contract.
// Transfer helpers hand custody back by calling `release` again; none of them
// implements its own retry.
type OwnedMachineTransferLease = {
    release: () => Promise<void>;
    retainedAfterFailure: boolean;
};
const ownedMachineTransferLeases = new Map<string, OwnedMachineTransferLease>();

/** Finite-transfer listener lease ids retained after a failed native stop. */
export function readRetainedIrohMachineTransferLeaseIds(): readonly string[] {
    return [...ownedMachineTransferLeases]
        .filter(([, owned]) => owned.retainedAfterFailure)
        .map(([leaseId]) => leaseId);
}

/** Retries every retained release. Used by the next tunnel start and by disposal. */
export async function releaseRetainedIrohMachineTransferLeases(): Promise<void> {
    const errors: unknown[] = [];
    for (const owned of [...ownedMachineTransferLeases.values()]) {
        if (!owned.retainedAfterFailure) continue;
        try {
            await owned.release();
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
        throw new AggregateError(errors, 'Failed to release every retained Iroh machine transfer lease.');
    }
}

function createOwnedMachineTransferLeaseRelease(
    leaseId: string,
    stop: (leaseId: string) => Promise<void>,
): () => Promise<void> {
    let releasePromise: Promise<void> | null = null;
    let released = false;
    const release = (): Promise<void> => {
        if (released) return Promise.resolve();
        releasePromise ??= stop(leaseId).then(() => {
            released = true;
            ownedMachineTransferLeases.delete(leaseId);
        }).catch((error: unknown) => {
            // Concurrent callers still share one attempt, but a failed native
            // stop stays owned and retryable through a later release/dispose.
            releasePromise = null;
            const owned = ownedMachineTransferLeases.get(leaseId);
            if (owned) owned.retainedAfterFailure = true;
            throw error;
        });
        return releasePromise;
    };
    ownedMachineTransferLeases.set(leaseId, { release, retainedAfterFailure: false });
    return release;
}

/**
 * Machine tunnels are foreground-only on mobile. The existing shared
 * app-activity owner invokes this companion runtime; no Machine-specific
 * AppState listener or second lifecycle owner is installed.
 */
export const irohMachineTransferRuntimeActivity = Object.freeze({
    markSuspended(): void {
        for (const owned of [...ownedMachineTransferLeases.values()]) {
            // A failed stop remains in the retained cleanup map and is retried
            // by the next start or global Iroh disposal.
            void owned.release().catch(() => undefined);
        }
    },
    async markForeground(): Promise<void> {
        // Finite operations own retrying their transfer. There is no durable
        // Machine tunnel to reacquire when the app returns to foreground.
    },
});

function readLease(value: unknown, stop: (leaseId: string) => Promise<void>, http: true): Promise<IrohMachineHttpNativeLease>;
function readLease(value: unknown, stop: (leaseId: string) => Promise<void>, http?: false): Promise<IrohMachineTransferNativeLease>;
async function readLease(
    value: unknown,
    stop: (leaseId: string) => Promise<void>,
    http = false,
): Promise<IrohMachineTransferNativeLease | IrohMachineHttpNativeLease> {
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    const leaseId = record.leaseId;
    if (typeof leaseId !== 'string' || leaseId.length === 0) {
        throw new Error('Iroh machine transfer lease is unavailable');
    }
    // Native has transferred ownership as soon as it returns a usable lease
    // id. Validate the remaining response only after installing cleanup
    // custody so malformed connection facts cannot orphan that handle.
    const release = createOwnedMachineTransferLeaseRelease(leaseId, stop);
    const localOrigin = record.localOrigin;
    const localCapability = record.localCapability;
    try {
        if (http && (typeof localCapability !== 'string' || !/^[0-9a-f]{64}$/u.test(localCapability))) {
            throw new Error('Iroh HTTP machine tunnel lease returned an invalid local capability');
        }
        if (!http && localCapability !== undefined && localCapability !== null && localCapability !== '') {
            throw new Error('Iroh raw machine transfer lease returned an unexpected local capability');
        }
        if (typeof localOrigin !== 'string') {
            throw new Error('Iroh machine transfer lease is unavailable');
        }
        let parsed: URL;
        try {
            parsed = new URL(localOrigin);
        } catch {
            throw new Error('Iroh machine transfer lease returned an invalid local origin');
        }
        const port = Number(parsed.port);
        if (
            parsed.protocol !== 'http:'
            || parsed.hostname !== '127.0.0.1'
            || !Number.isInteger(port)
            || port < 1
            || port > 65_535
            || parsed.username !== ''
            || parsed.password !== ''
            || parsed.pathname !== '/'
            || parsed.search !== ''
            || parsed.hash !== ''
        ) {
            throw new Error('Iroh machine transfer lease returned an invalid local origin');
        }
        return {
            leaseId,
            localOrigin: parsed.origin,
            release,
            ...(http && typeof localCapability === 'string' ? {
                requestHeaders: { [IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]: localCapability },
                webSocketProtocols: [`${IROH_MACHINE_WEBSOCKET_CAPABILITY_PROTOCOL_PREFIX}${localCapability}`],
            } : {}),
        };
    } catch (error) {
        await release().catch(() => undefined);
        throw error;
    }
}

let desktopAvailability: boolean | null = null;
let desktopAvailabilityProbe: Promise<boolean> | null = null;
const desktopAvailabilityListeners = new Set<() => void>();

function publishDesktopAvailability(available: boolean): void {
    const changed = desktopAvailability !== available;
    desktopAvailability = available;
    if (!changed) return;
    for (const listener of desktopAvailabilityListeners) listener();
}

export function subscribeIrohMachineTransferLifecycleAvailability(listener: () => void): () => void {
    desktopAvailabilityListeners.add(listener);
    return () => desktopAvailabilityListeners.delete(listener);
}

export function isIrohMachineTransferLifecycleAvailable(): boolean {
    if (desktopHostKind() !== null) return desktopAvailability === true;
    const native = getOptionalHappierIrohNativeModule();
    return Boolean(
        native?.getAvailability?.().available === true
        && native.startMachineTunnel
        && native.stopMachineTunnel,
    );
}

/** Probes the real loaded host/native boundary before route selection. */
export async function probeIrohMachineTransferLifecycleAvailability(): Promise<boolean> {
    if (desktopHostKind() === null) return isIrohMachineTransferLifecycleAvailable();
    desktopAvailabilityProbe ??= (async () => {
        let available = false;
        try {
            const value = await invokeDesktopHost<unknown>('iroh_get_availability');
            available = typeof value === 'object'
                && value !== null
                && (value as Record<string, unknown>).available === true;
        } catch {
            available = false;
        }
        publishDesktopAvailability(available);
        return available;
    })().finally(() => {
        desktopAvailabilityProbe = null;
    });
    return await desktopAvailabilityProbe;
}

async function requireMobileModule(): Promise<NativeIrohModule> {
    const native = getOptionalHappierIrohNativeModule();
    if (!native?.createEndpoint || !native.startMachineTunnel || !native.stopMachineTunnel) {
        throw new Error('Iroh machine transfer lifecycle is unavailable');
    }
    return native;
}

export async function getIrohApplicationEndpoint(
    configuration: IrohApplicationEndpointConfiguration = {},
): Promise<IrohApplicationEndpoint> {
    if (desktopHostKind() !== null) {
        return readEndpoint(await invokeDesktopHost('iroh_get_application_endpoint', { request: configuration }));
    }
    const native = await requireMobileModule();
    return readEndpoint(await ensureIrohApplicationEndpoint(native, configuration));
}

export type IrohMachineTunnelStartInput = Readonly<{
    endpointId: string;
    directAddresses?: readonly string[];
    relayUrls?: readonly string[];
    policy?: 'automatic' | 'disabled';
    handshakeJson: string;
    /** A guest-safe preview listener; its signed mux open stays in native custody. */
    nativeHttpLease?: Readonly<{ openJson: string }>;
}>;

export async function startIrohMachineTransferTunnel(input: IrohMachineTunnelStartInput): Promise<IrohMachineTransferNativeLease> {
    return await startMachineTunnel(input, false);
}

export async function startIrohMachineHttpTunnel(input: IrohMachineTunnelStartInput): Promise<IrohMachineHttpNativeLease> {
    return await startMachineTunnel(input, true);
}

function startMachineTunnel(input: IrohMachineTunnelStartInput, http: true): Promise<IrohMachineHttpNativeLease>;
function startMachineTunnel(input: IrohMachineTunnelStartInput, http: false): Promise<IrohMachineTransferNativeLease>;
async function startMachineTunnel(input: IrohMachineTunnelStartInput, http: boolean): Promise<IrohMachineTransferNativeLease | IrohMachineHttpNativeLease> {
    // Retry cleanup a previous transfer could not complete before this owner
    // adds another native lease. Only already-failed releases are retained, so
    // this never disturbs a lease an in-flight transfer still uses.
    await releaseRetainedIrohMachineTransferLeases();
    if (desktopHostKind() !== null) {
        const started = await invokeDesktopHost<unknown>(http ? 'iroh_start_machine_http_tunnel' : 'iroh_start_machine_tunnel', { request: input });
        const record = typeof started === 'object' && started !== null
            ? started as Record<string, unknown>
            : {};
        const response = {
            leaseId: record.leaseId,
            localOrigin: http ? record.localOrigin : typeof record.localPort === 'number'
                ? `http://127.0.0.1:${record.localPort}`
                : null,
            localCapability: record.localCapability,
        };
        const stop = async (leaseId: string): Promise<void> => {
            await invokeDesktopHost('iroh_stop_machine_tunnel', { leaseId });
        };
        const lease = http ? await readLease(response, stop, true) : await readLease(response, stop);
        return input.nativeHttpLease ? {
            ...lease,
            // Losing observation also retires this listener rather than leaving
            // an unobservable native origin suppressing server admission.
            closed: invokeDesktopHost<void>('iroh_wait_machine_tunnel_closed', { leaseId: lease.leaseId }).catch(() => undefined),
        } : lease;
    }
    if (!isRuntimeActive()) {
        throw new IrohError('unavailable', IROH_HOME_TUNNEL_SUSPENDED_ERROR);
    }
    const native = await requireMobileModule();
    if (input.nativeHttpLease && !native.waitMachineTunnelClosed) {
        throw new Error('Iroh native preview lifecycle observation is unavailable');
    }
    const endpoint = await ensureIrohApplicationEndpoint(native, {
        ...(input.policy ? { policy: input.policy } : {}),
        ...(input.relayUrls ? { relayUrls: input.relayUrls } : {}),
    });
    const start = http ? native.startMachineHttpTunnel : native.startMachineTunnel;
    if (!start) throw new Error('Iroh machine tunnel carrier is unavailable');
    const started = await start.call(native, {
        endpointHandle: endpoint.endpointHandle,
        endpointId: input.endpointId,
        directAddresses: input.directAddresses,
        relayUrls: input.relayUrls,
        handshakeJson: input.handshakeJson,
        capProfile: 'machineBulk',
        ...(input.nativeHttpLease ? { nativeHttpLease: input.nativeHttpLease } : {}),
    });
    const response = {
        leaseId: started.machineTunnelId,
        localOrigin: `http://127.0.0.1:${started.localPort}`,
        localCapability: started.localCapability,
    };
    const stop = async (leaseId: string): Promise<void> => await native.stopMachineTunnel!(leaseId);
    const lease = http ? await readLease(response, stop, true) : await readLease(response, stop);
    if (!isRuntimeActive()) {
        await lease.release().catch(() => undefined);
        throw new IrohError('unavailable', IROH_HOME_TUNNEL_SUSPENDED_ERROR);
    }
    return input.nativeHttpLease ? {
        ...lease,
        closed: Promise.resolve().then(() => native.waitMachineTunnelClosed!(lease.leaseId)).catch(() => undefined),
    } : lease;
}
