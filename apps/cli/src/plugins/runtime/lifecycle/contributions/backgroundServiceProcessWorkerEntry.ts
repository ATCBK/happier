import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type {
    resolveBackgroundServiceProcessBootstrap,
    BackgroundServiceProcessBootstrap,
    HostBackgroundServiceProcessContext,
} from './backgroundServiceProcessBootstrap';
import type { createBackgroundServiceProcessServiceClient, BackgroundServiceProcessBridgeValue } from './backgroundServiceProcessBridge';
import type { createBackgroundServiceProcessServices, BackgroundServiceProcessLocalPolicy } from './backgroundServiceProcessServices';
import {
    createBackgroundServiceProcessFrameDecoder,
    encodeBackgroundServiceProcessFrame,
    parseBackgroundServiceProcessMessage,
    type BackgroundServiceProcessMessage,
} from './backgroundServiceProcessProtocol';

export type BackgroundServiceProcessWorkerTransport = Readonly<{
    onData(listener: (chunk: Buffer) => void): void;
    onClose(listener: () => void): void;
    write(frame: Buffer): void;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('background_service_process_context_invalid');
    }
    return value as Readonly<Record<string, unknown>>;
}

function diagnostic(error: unknown): Readonly<{ code: string; message: string }> {
    return {
        code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
            ? error.code : 'background_service_failed',
        message: error instanceof Error ? error.message : String(error),
    };
}

/** Child-side run host. All source/admission and service authority comes from the parent frames. */
export async function runBackgroundServiceProcessWorker(
    transport: BackgroundServiceProcessWorkerTransport,
    options?: Parameters<typeof resolveBackgroundServiceProcessBootstrap>[1],
): Promise<void> {
    const decoder = createBackgroundServiceProcessFrameDecoder();
    let initialized: Promise<Awaited<ReturnType<typeof resolveBackgroundServiceProcessBootstrap>>> | undefined;
    let createServiceClient: typeof createBackgroundServiceProcessServiceClient | undefined;
    let active: Readonly<{
        id: string;
        controller: AbortController;
        services: ReturnType<typeof createBackgroundServiceProcessServiceClient>;
        task: Promise<void>;
    }> | undefined;
    let stopping = false;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    const send = (message: BackgroundServiceProcessMessage): void => transport.write(encodeBackgroundServiceProcessFrame(message));
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
        closing ??= (async () => {
            stopping = true;
            active?.controller.abort();
            await active?.task;
            const loaded = await initialized?.catch(() => undefined);
            await loaded?.dispose();
            resolveClosed();
        })().catch(rejectClosed);
        return closing;
    };

    const receive = (message: BackgroundServiceProcessMessage): void => {
        switch (message.kind) {
            case 'initialize': {
                if (initialized || stopping) throw new Error('background_service_process_already_initialized');
                // This private same-binary payload is projected by the daemon's sole admission owner.
                initialized = (async () => {
                    const [bootstrap, bridge] = await Promise.all([
                        import('./backgroundServiceProcessBootstrap'),
                        import('./backgroundServiceProcessBridge'),
                    ]);
                    createServiceClient = bridge.createBackgroundServiceProcessServiceClient;
                    return await bootstrap.resolveBackgroundServiceProcessBootstrap(message.bootstrap as BackgroundServiceProcessBootstrap, options);
                })();
                void initialized.then(() => {
                    if (!stopping) send({ kind: 'ready', pid: process.pid });
                }, error => {
                    send({ kind: 'failed', id: 'initialize', error: diagnostic(error) });
                    void close();
                });
                return;
            }
            case 'run': {
                if (!initialized || !createServiceClient || active || stopping) throw new Error('background_service_process_run_invalid');
                const controller = new AbortController();
                const services = createServiceClient<Readonly<Record<string, unknown>>>({
                    // The client validates this wire value before reconstructing any callable root.
                    description: message.services as BackgroundServiceProcessBridgeValue,
                    signal: controller.signal,
                    send: bridgeMessage => send({ kind: 'services', message: bridgeMessage }),
                });
                const metadata = record(message.context);
                const task = Promise.resolve().then(async () => {
                    let local: ReturnType<typeof createBackgroundServiceProcessServices> | undefined;
                    try {
                        const loaded = await initialized!;
                        const { createBackgroundServiceProcessServices } = await import('./backgroundServiceProcessServices');
                        // Local policy is the daemon-admitted projection, never selected or re-admitted here.
                        local = createBackgroundServiceProcessServices({
                            metadata, signal: controller.signal,
                            clientServices: services.services,
                            ...(message.localPolicy === undefined ? {} : {
                                localPolicy: message.localPolicy as BackgroundServiceProcessLocalPolicy,
                            }),
                        });
                        const context = {
                            ...metadata, signal: controller.signal, services: local.services,
                            isOccurrenceCurrent: () => !stopping && !controller.signal.aborted,
                        };
                        // Plugin metadata was stamped by the parent's canonical invocation owner.
                        await loaded.run(context as BackgroundServiceContext | HostBackgroundServiceProcessContext);
                    } finally {
                        try { await local?.dispose(); }
                        finally { await services.dispose(); }
                    }
                }).then(() => {
                    active = undefined;
                    send({ kind: 'settled', id: message.id });
                }, error => {
                    active = undefined;
                    send({ kind: 'failed', id: message.id, error: diagnostic(error) });
                });
                active = { id: message.id, controller, services, task };
                return;
            }
            case 'abort':
                if (active?.id === message.id) active.controller.abort();
                return;
            case 'services': active?.services.receive(message.message); return;
            case 'stop': void close(); return;
            default: throw new Error('background_service_protocol_direction_invalid');
        }
    };
    transport.onData(chunk => {
        try {
            for (const value of decoder.push(chunk)) receive(parseBackgroundServiceProcessMessage(value));
        } catch (error) {
            send({ kind: 'failed', id: active?.id ?? 'initialize', error: diagnostic(error) });
            void close();
        }
    });
    transport.onClose(() => { void close(); });
    await closed;
}

/** Hidden binary-safe CLI entry. Stdout belongs exclusively to framed IPC. */
export async function runBackgroundServiceProcessWorkerChild(
    options?: Parameters<typeof resolveBackgroundServiceProcessBootstrap>[1],
): Promise<void> {
    const onClosed = new Set<() => void>();
    const finish = () => { for (const listener of onClosed) listener(); };
    process.stdin.on('end', finish);
    process.stdin.on('close', finish);
    process.once('SIGTERM', finish);
    process.once('SIGINT', finish);
    try {
        await runBackgroundServiceProcessWorker({
            onData(listener) { process.stdin.on('data', listener); },
            onClose(listener) { onClosed.add(listener); },
            write(frame) { process.stdout.write(frame); },
        }, options);
    } finally {
        process.stdin.pause();
        process.stdin.removeListener('end', finish);
        process.stdin.removeListener('close', finish);
        process.removeListener('SIGTERM', finish);
        process.removeListener('SIGINT', finish);
    }
}
