/**
 * The narrow `happier/machine/1` opener the existing machine-carrier seam
 * consumes (Lane 06 A7.4).
 *
 * `machineCarrierBrowserStream` owns machine admission: it mints the signed
 * handshake through the one canonical mint owner, writes the canonical frame,
 * and reads the single admission decision byte. It needs exactly two things
 * from the browser endpoint — an endpoint lease whose EndpointId is the
 * initiator's transport identity, and a raw machine/1 duplex to the exact
 * signed target. This module is that adapter and nothing more.
 *
 * It supplies no local origin and no `runtimeOrigin`: a browser cannot bind
 * one, and none is fabricated. It interprets no ALPN string either — the
 * requested protocol is the closed `'machine'` stream kind, which the endpoint
 * owner routes to the generated machine operation, which applies the shared
 * core's `MACHINE_ALPN`.
 *
 * The canonical transfer route owner consumes this binding through
 * `acquireBrowserMachineCarrierHttpLease`, once a browser host and a target
 * descriptor make the Iroh route eligible.
 */

import type {
    AcquireBrowserMachineCarrierEndpointLease,
    MachineCarrierStreamDuplex,
    OpenMachineCarrierStream,
} from '@/sync/domains/transfers/runtime/transferRuntime';

import type { BrowserIrohEndpointClient, BrowserIrohLease } from './endpointClient';

export class BrowserMachineCarrierEndpointError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BrowserMachineCarrierEndpointError';
    }
}

export type BrowserMachineCarrierEndpointBinding = Readonly<{
    acquireEndpointLease: AcquireBrowserMachineCarrierEndpointLease;
    openMachineCarrierStream: OpenMachineCarrierStream;
}>;

/**
 * Binds one acquisition's endpoint lease to its machine opener.
 *
 * The seam acquires the lease (to learn the initiator EndpointId the grant is
 * minted against) and then opens the stream, and the stream must be opened
 * under that same lease — an opaque stream is custody of the client and lease
 * that owns it. Creating one binding per acquisition is what keeps that pairing
 * explicit instead of leaving the opener to guess which lease it belongs to.
 */
export function createBrowserMachineCarrierEndpointBinding(
    client: BrowserIrohEndpointClient,
): BrowserMachineCarrierEndpointBinding {
    let lease: BrowserIrohLease | null = null;

    return {
        acquireEndpointLease: async (relayUrls) => {
            const acquired = await client.acquireLease(relayUrls);
            lease = acquired;
            return {
                endpointId: acquired.endpointId,
                release: async () => {
                    lease = null;
                    await acquired.release();
                },
            };
        },

        openMachineCarrierStream: async ({ endpointId, relayUrls, signal }): Promise<MachineCarrierStreamDuplex> => {
            const held = lease;
            if (held === null) {
                throw new BrowserMachineCarrierEndpointError(
                    'The browser machine carrier has no endpoint lease to open a machine stream under.',
                );
            }
            // Refused before the dial rather than cancelled after it, so an
            // already-abandoned operation never leaves a stream in custody for
            // the transfer owner to release.
            if (signal?.aborted === true) {
                throw new BrowserMachineCarrierEndpointError(
                    'The browser machine carrier request was aborted before its machine stream opened.',
                );
            }
            const stream = await held.openStream({
                streamKind: 'machine',
                endpointId,
                relayUrls,
                ...(signal ? { signal } : {}),
            });
            return {
                // The transport's proven peer, which the seam checks against the
                // signed target before any handshake byte moves.
                remoteEndpointId: stream.remoteEndpointId,
                observedPath: stream.observedPath,
                read: stream.read,
                write: stream.write,
                finishWrite: stream.finishWrite,
                cancel: stream.cancel,
                close: stream.close,
            };
        },
    };
}
