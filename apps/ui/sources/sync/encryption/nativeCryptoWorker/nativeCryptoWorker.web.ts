import { ENCRYPTED_DATA_KEY_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeFormatV1';
import {
    NATIVE_CRYPTO_WORKER_OPERATION,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    NativeCryptoWorkerUnavailableError,
    type CryptoWorkerBatchRequest,
    type NativeCryptoWorker,
    type NativeCryptoWorkerAesGcmJsonItem,
    type NativeCryptoWorkerBatchResult,
    type NativeCryptoWorkerDataKeyEnvelopeItem,
    type NativeCryptoWorkerSecretboxJsonItem,
} from './types';
import { bytesToCryptoWorkerBase64, cryptoWorkerBase64ToBytes } from './nativeCryptoWorkerBridgePayload';
import type { WebCryptoWorkerItem, WebCryptoWorkerResponse } from './webCryptoWorkerRuntime';

function unavailableResult<T>(request: CryptoWorkerBatchRequest<unknown>): NativeCryptoWorkerBatchResult<T> {
    if (request.signal?.aborted === true) {
        return { status: 'cancelled', source: 'cancelled', items: [] };
    }
    throw new NativeCryptoWorkerUnavailableError(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unsupportedPlatform);
}

// Encryption instances (including short-lived Action readers) keep distinct
// queue/capability owners, but share this stateless document-lifetime transport.
let worker: Worker | undefined;
let transportTail = Promise.resolve();
let failActiveDispatch: ((error: unknown) => void) | undefined;

function discardWorker(discarded: Worker): void {
    discarded.onmessage = null;
    discarded.onerror = null;
    discarded.onmessageerror = null;
    discarded.terminate();
    if (worker === discarded) worker = undefined;
}

function getWorker(): Worker {
    if (worker) return worker;
    const created = new Worker('/happier-crypto-worker.js');
    worker = created;
    const fail = (error: unknown) => {
        if (worker !== created) return;
        if (failActiveDispatch) failActiveDispatch(error);
        else discardWorker(created);
    };
    // Keep lifetime error handlers while idle so a failed Worker can never be
    // retained for a later request. Retired Worker events cannot retire its replacement.
    created.onerror = (event) => {
        event.preventDefault();
        fail(event.error instanceof Error ? event.error : new Error('Web crypto worker failed'));
    };
    created.onmessageerror = () => fail(new Error('Invalid web crypto worker message'));
    return created;
}

export function createNativeCryptoWorker(): NativeCryptoWorker {
    return {
        async probe() {
            return typeof Worker !== 'function' ? {
                available: false,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unsupportedPlatform,
            } : {
                available: true,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                supportedOperations: [NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1],
            };
        },
        async decryptDataKeyEnvelopeV1(
            request: CryptoWorkerBatchRequest<NativeCryptoWorkerDataKeyEnvelopeItem>,
        ): Promise<NativeCryptoWorkerBatchResult<string | null>> {
            if (request.signal?.aborted) return { status: 'cancelled', source: 'cancelled', items: [] };
            if (typeof Worker !== 'function') return unavailableResult(request);
            if (request.items.length === 0) return { status: 'ok', source: 'native', items: [] };

            // Queues are scoped, but adapters can receive concurrent scopes.
            // Serialize its request/reply transport so the existing array protocol
            // can reuse one Worker without assigning one caller another's reply.
            const previous = transportTail;
            let release!: () => void;
            const completed = new Promise<void>((resolve) => { release = resolve; });
            transportTail = previous.then(() => completed);
            return new Promise((resolve, reject) => {
                let dispatchedWorker: Worker | undefined;
                let settled = false;
                const cleanup = (shouldDiscardWorker: boolean) => {
                    if (settled) return false;
                    settled = true;
                    request.signal?.removeEventListener('abort', onAbort);
                    if (dispatchedWorker) {
                        dispatchedWorker.onmessage = null;
                        failActiveDispatch = undefined;
                        if (shouldDiscardWorker) discardWorker(dispatchedWorker);
                    }
                    release();
                    return true;
                };
                const fail = (error: unknown) => {
                    if (cleanup(true)) reject(error);
                };
                const onAbort = () => {
                    if (cleanup(true)) {
                        resolve({ status: 'cancelled', source: 'cancelled', items: [] });
                    }
                };
                request.signal?.addEventListener('abort', onAbort, { once: true });
                void previous.then(() => {
                    if (settled) return;
                    if (request.signal?.aborted) { onAbort(); return; }
                    try {
                        // The Worker retains its code, never Account key state:
                        // its canonical handler wipes each request's recipient key.
                        dispatchedWorker = getWorker();
                        failActiveDispatch = fail;
                        dispatchedWorker.onmessage = ({ data }: MessageEvent<WebCryptoWorkerResponse>) => {
                            if (settled) return;
                            if (data?.status === 'error' && typeof data.error?.message === 'string'
                                && typeof data.error.name === 'string') {
                                const error = new Error(data.error.message);
                                error.name = data.error.name;
                                fail(error);
                            } else if (data?.status !== 'ok' || !Array.isArray(data.items)
                                || data.items.length !== request.items.length
                                || data.items.some(item => item !== null && (!(item instanceof Uint8Array) || item.length !== ENCRYPTED_DATA_KEY_V1_BYTES))) {
                                fail(new Error('Invalid web crypto worker response'));
                            } else {
                                const items = data.items.map(item => item ? bytesToCryptoWorkerBase64(item) : null);
                                if (cleanup(false)) resolve({ status: 'ok', source: 'native', items });
                            }
                        };
                        const items: (WebCryptoWorkerItem | null)[] = request.items.map(item => {
                            const envelope = cryptoWorkerBase64ToBytes(item.envelopeBase64);
                            const recipientSecretKeyOrSeed = cryptoWorkerBase64ToBytes(item.recipientSecretKeyOrSeedBase64);
                            return envelope && recipientSecretKeyOrSeed
                                ? { envelope: envelope.slice(), recipientSecretKeyOrSeed: recipientSecretKeyOrSeed.slice() }
                                : null;
                        });
                        dispatchedWorker.postMessage(items, items.flatMap(item => item ? [item.envelope.buffer, item.recipientSecretKeyOrSeed.buffer] : []));
                    } catch (error) {
                        fail(error);
                    }
                });
            });
        },
        async decryptSecretboxJson(
            request: CryptoWorkerBatchRequest<NativeCryptoWorkerSecretboxJsonItem>,
        ): Promise<NativeCryptoWorkerBatchResult<unknown | null>> {
            return unavailableResult(request);
        },
        async decryptAesGcmJson(
            request: CryptoWorkerBatchRequest<NativeCryptoWorkerAesGcmJsonItem>,
        ): Promise<NativeCryptoWorkerBatchResult<unknown | null>> {
            return unavailableResult(request);
        },
    };
}
