import { isPluginError, PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { z } from 'zod';

/** Private, same-binary stdio ABI. This is not an independently versioned SDK wire surface. */
export type BackgroundServiceProcessBridgeValue =
    | null | boolean | number | string
    | Readonly<{ t: 'undefined' }>
    | Readonly<{ t: 'bytes' | 'bigint'; value: string }>
    | Readonly<{ t: 'array'; items: readonly BackgroundServiceProcessBridgeValue[] }>
    | Readonly<{ t: 'object'; entries: readonly (readonly [string, BackgroundServiceProcessBridgeValue])[] }>
    | Readonly<{ t: 'function'; id: string; subscription: boolean }>
    | Readonly<{ t: 'promise'; id: string }>
    | Readonly<{ t: 'errorValue'; error: BridgeError }>
    | Readonly<{ t: 'snapshot'; value: BackgroundServiceProcessBridgeValue }>
    | Readonly<{ t: 'scopeSelector'; account: BackgroundServiceProcessBridgeValue; daemon: BackgroundServiceProcessBridgeValue }>
    | Readonly<{ t: 'throw'; error: BridgeError }>
    | Readonly<{ t: 'signal'; id: string; aborted: boolean; reason?: BackgroundServiceProcessBridgeValue }>;

type BridgeError = Readonly<{ name: string; message: string; data?: BackgroundServiceProcessBridgeValue }>;
export type BackgroundServiceProcessBridgeMessage =
    | Readonly<{ kind: 'call'; id: string; method: string; args: BackgroundServiceProcessBridgeValue }>
    | Readonly<{ kind: 'return'; id: string; value: BackgroundServiceProcessBridgeValue }>
    | Readonly<{ kind: 'error'; id: string; error: BridgeError }>
    | Readonly<{ kind: 'abort'; id: string; reason?: BackgroundServiceProcessBridgeValue }>
    | Readonly<{ kind: 'release'; ids: readonly string[] }>
    | Readonly<{ kind: 'close' }>;

type Send = (message: BackgroundServiceProcessBridgeMessage) => void;
type ProxiedServices = Pick<PluginServices, 'storage' | 'settings' | 'events' | 'sessions' | 'actions'>;
type Callable = (...args: unknown[]) => unknown;
type ExportScope = { ids: string[]; signals: string[]; cleanups: (() => void)[] };

const bridgeErrorSchema: z.ZodType<BridgeError> = z.lazy(() => z.object({
    name: z.string(), message: z.string(), data: bridgeValueSchema.optional(),
}).strict());
const bridgeValueSchema: z.ZodType<BackgroundServiceProcessBridgeValue> = z.lazy(() => z.union([
    z.null(), z.boolean(), z.number().finite(), z.string(),
    z.object({ t: z.literal('undefined') }).strict(),
    z.object({ t: z.enum(['bytes', 'bigint']), value: z.string() }).strict(),
    z.object({ t: z.literal('array'), items: z.array(bridgeValueSchema) }).strict(),
    z.object({ t: z.literal('object'), entries: z.array(z.tuple([z.string(), bridgeValueSchema])) }).strict(),
    z.object({ t: z.literal('function'), id: z.string(), subscription: z.boolean() }).strict(),
    z.object({ t: z.literal('promise'), id: z.string() }).strict(),
    z.object({ t: z.literal('errorValue'), error: bridgeErrorSchema }).strict(),
    z.object({ t: z.literal('snapshot'), value: bridgeValueSchema }).strict(),
    z.object({ t: z.literal('scopeSelector'), account: bridgeValueSchema, daemon: bridgeValueSchema }).strict(),
    z.object({ t: z.literal('throw'), error: bridgeErrorSchema }).strict(),
    z.object({ t: z.literal('signal'), id: z.string(), aborted: z.boolean(), reason: bridgeValueSchema.optional() }).strict(),
]));
const bridgeMessageSchema: z.ZodType<BackgroundServiceProcessBridgeMessage> = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('call'), id: z.string(), method: z.string(), args: bridgeValueSchema }).strict(),
    z.object({ kind: z.literal('return'), id: z.string(), value: bridgeValueSchema }).strict(),
    z.object({ kind: z.literal('error'), id: z.string(), error: bridgeErrorSchema }).strict(),
    z.object({ kind: z.literal('abort'), id: z.string(), reason: bridgeValueSchema.optional() }).strict(),
    z.object({ kind: z.literal('release'), ids: z.array(z.string()) }).strict(),
    z.object({ kind: z.literal('close') }).strict(),
]);

function closedError(): PluginError {
    return new PluginError({ code: 'background_service_process_bridge_closed', message: 'Background service process transport closed' });
}

/** One bidirectional object-capability bridge for service calls and host-invoked callbacks. */
function createPeer(send: Send, signal?: AbortSignal) {
    let nextId = 0;
    let closed = false;
    const methods = new Map<string, Callable>();
    const receivedSignals = new Map<string, AbortController>();
    const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; scope: ExportScope; retain: boolean }>();
    const scopes = new Set<ExportScope>();
    const subscriptions = new Set<{ dispose(): unknown }>();
    const id = () => String(++nextId);
    const newScope = (): ExportScope => {
        const scope: ExportScope = { ids: [], signals: [], cleanups: [] };
        scopes.add(scope);
        return scope;
    };
    const release = (scope: ExportScope) => {
        if (!scopes.delete(scope)) return;
        for (const key of scope.ids) methods.delete(key);
        for (const cleanup of scope.cleanups) cleanup();
        if (!closed && scope.signals.length > 0) send({ kind: 'release', ids: scope.signals });
    };
    function encodeError(error: unknown, scope: ExportScope): BridgeError {
        return {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
            ...(isPluginError(error) ? { data: encode(error.data, scope) } : {}),
        };
    }
    function decodeError(error: BridgeError): Error {
        if (error.data !== undefined) {
            // PluginError owns validation of its public diagnostic data.
            const data = decode(error.data);
            if (typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string' && 'message' in data && typeof data.message === 'string') {
                return new PluginError(data as ConstructorParameters<typeof PluginError>[0]);
            }
        }
        const result = new Error(error.message);
        result.name = error.name;
        return result;
    }
    function encode(value: unknown, scope: ExportScope, property?: string, parent?: object, ancestors = new Set<object>()): BackgroundServiceProcessBridgeValue {
        if (value === undefined) return { t: 'undefined' };
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'bigint') return { t: 'bigint', value: String(value) };
        if (value instanceof Uint8Array) return { t: 'bytes', value: Buffer.from(value).toString('base64') };
        if (value instanceof Error) return { t: 'errorValue', error: encodeError(value, scope) };
        if (value instanceof Promise) {
            const key = id();
            methods.set(key, () => value);
            scope.ids.push(key);
            // The property may be decoded only after a channel failure.
            void value.catch(() => {});
            return { t: 'promise', id: key };
        }
        if (value instanceof AbortSignal) {
            const key = id();
            const reason = (): BackgroundServiceProcessBridgeValue | undefined => {
                try { return encode(value.reason, scope); }
                catch { return undefined; } // Abort accepts arbitrary JS values; unsupported reasons still cancel.
            };
            const abort = () => { if (!closed) send({ kind: 'abort', id: key, reason: reason() }); };
            value.addEventListener('abort', abort, { once: true });
            scope.signals.push(key);
            scope.cleanups.push(() => value.removeEventListener('abort', abort));
            return { t: 'signal', id: key, aborted: value.aborted, ...(value.aborted ? { reason: reason() } : {}) };
        }
        if (typeof value === 'function') {
            let call: Callable = (...args) => Reflect.apply(value, parent, args);
            // These SDK reads are synchronous and immutable for the admitted run.
            if (property === 'describe' || property === 'consistency') {
                try { return { t: 'snapshot', value: encode(call(), scope) }; }
                catch (error) { return { t: 'throw', error: encodeError(error, scope) }; }
            }
            if (property === 'forScope') {
                const select = (kind: 'account' | 'daemon'): BackgroundServiceProcessBridgeValue => {
                    try { return encode(call({ kind }), scope); }
                    catch (error) { return { t: 'throw', error: encodeError(error, scope) }; }
                };
                return { t: 'scopeSelector', account: select('account'), daemon: select('daemon') };
            }
            if (property === 'dispose' && parent) {
                const disposable = parent as { dispose(): unknown };
                subscriptions.add(disposable);
                call = async (...args) => {
                    try { return await Reflect.apply(value, parent, args); }
                    finally { subscriptions.delete(disposable); release(scope); }
                };
            }
            const key = id();
            methods.set(key, call);
            scope.ids.push(key);
            return { t: 'function', id: key, subscription: property === 'watch' || property === 'subscribe' };
        }
        if (typeof value !== 'object' || value === null || ancestors.has(value)) {
            throw new PluginError({ code: 'background_service_process_value_unsupported', message: 'Service value cannot cross the process boundary' });
        }
        ancestors.add(value);
        try {
            if (Array.isArray(value)) return { t: 'array', items: value.map((entry) => encode(entry, scope, undefined, undefined, ancestors)) };
            if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
                throw new PluginError({ code: 'background_service_process_value_unsupported', message: 'Service objects must expose their public structural contract' });
            }
            return { t: 'object', entries: Object.entries(value).map(([key, entry]) => [key, encode(entry, scope, key, value, ancestors)] as const) };
        } finally { ancestors.delete(value); }
    }
    function invoke(method: string, args: readonly unknown[], retain = false): { promise: Promise<unknown>; scope: ExportScope } {
        const scope = newScope();
        if (closed) {
            release(scope);
            const promise = Promise.reject(closedError());
            void promise.catch(() => {});
            return { promise, scope };
        }
        const requestId = id();
        const promise = new Promise<unknown>((resolve, reject) => {
            pending.set(requestId, { resolve, reject, scope, retain });
            try { send({ kind: 'call', id: requestId, method, args: encode(args, scope) }); }
            catch (error) { pending.delete(requestId); release(scope); reject(error); }
        });
        // Some SDK callbacks and disposable methods have a void author signature.
        // Awaiting callers still receive the original rejection; ignoring a callback never leaks one.
        void promise.catch(() => {});
        return { promise, scope };
    }
    function decode(value: BackgroundServiceProcessBridgeValue, onDispose?: () => void): unknown {
        if (value === null || typeof value !== 'object') return value;
        switch (value.t) {
            case 'undefined': return undefined;
            case 'bytes': return new Uint8Array(Buffer.from(value.value, 'base64'));
            case 'bigint': return BigInt(value.value);
            case 'promise': {
                const promise = invoke(value.id, []).promise;
                void promise.catch(() => {});
                return promise;
            }
            case 'errorValue': return decodeError(value.error);
            case 'array': return value.items.map((entry) => decode(entry, onDispose));
            case 'object': return Object.fromEntries(value.entries.map(([key, entry]) => {
                const decoded = decode(entry, onDispose);
                if (key === 'dispose' && typeof decoded === 'function' && onDispose) {
                    return [key, (...args: unknown[]) => {
                        const disposal = (async () => { try { await decoded(...args); } finally { onDispose(); } })();
                        void disposal.catch(() => {});
                        return disposal;
                    }];
                }
                return [key, decoded];
            }));
            case 'snapshot': return () => decode(value.value);
            case 'throw': return () => { throw decodeError(value.error); };
            case 'scopeSelector': return (scope: { kind: 'account' | 'daemon' }) => {
                if (scope.kind !== 'account' && scope.kind !== 'daemon') throw new PluginError({ code: 'plugin_settings_scope_invalid', message: 'Unknown Settings scope' });
                const selected = value[scope.kind];
                if (typeof selected === 'object' && selected !== null && selected.t === 'throw') throw decodeError(selected.error);
                return decode(selected);
            };
            case 'signal': {
                const controller = new AbortController();
                if (value.aborted) controller.abort(value.reason === undefined ? undefined : decode(value.reason));
                receivedSignals.set(value.id, controller);
                return controller.signal;
            }
            case 'function': return (...args: unknown[]) => {
                const call = invoke(value.id, args, value.subscription);
                if (!value.subscription) return call.promise;
                let disposed: Promise<void> | undefined;
                const subscription = {
                    dispose(): Promise<void> {
                        disposed ??= (async () => {
                            try {
                                if (!closed) {
                                    const result = await call.promise;
                                    if (typeof result === 'object' && result !== null && 'dispose' in result && typeof result.dispose === 'function') await result.dispose();
                                }
                            } finally { release(call.scope); subscriptions.delete(subscription); }
                        })();
                        void disposed.catch(() => {});
                        return disposed;
                    },
                };
                subscriptions.add(subscription);
                // Observe registration failures even if the author never explicitly disposes.
                void call.promise.catch(() => { release(call.scope); subscriptions.delete(subscription); });
                return subscription;
            };
        }
    }
    async function disposeLateResult(value: unknown, visited = new Set<object>()): Promise<void> {
        if (typeof value !== 'object' || value === null || visited.has(value)) return;
        visited.add(value);
        if ('dispose' in value && typeof value.dispose === 'function') {
            await value.dispose();
            return;
        }
        await Promise.all(Object.values(value).map((entry) => disposeLateResult(entry, visited)));
    }
    async function handleCall(message: Extract<BackgroundServiceProcessBridgeMessage, { kind: 'call' }>): Promise<void> {
        const scope = newScope();
        try {
            const method = methods.get(message.method);
            if (!method) throw new PluginError({ code: 'background_service_process_method_unavailable', message: 'Service method is not bound to this process' });
            const args = decode(message.args);
            if (!Array.isArray(args)) throw new PluginError({ code: 'background_service_process_request_invalid', message: 'Invalid service call arguments' });
            const result = await method(...args);
            if (!closed) {
                const encoded = encode(result, scope);
                send({ kind: 'return', id: message.id, value: encoded });
                if (scope.ids.length === 0 && scope.cleanups.length === 0) release(scope);
            } else {
                await disposeLateResult(result);
                release(scope);
            }
        } catch (error) {
            if (!closed) send({ kind: 'error', id: message.id, error: encodeError(error, scope) });
            release(scope);
        }
    }
    function hasReferences(value: BackgroundServiceProcessBridgeValue): boolean {
        if (typeof value !== 'object' || value === null) return false;
        if (value.t === 'function' || value.t === 'promise') return true;
        if (value.t === 'object') return value.entries.some(([, entry]) => hasReferences(entry));
        if (value.t === 'array') return value.items.some(hasReferences);
        return false;
    }
    function receive(input: unknown): void {
        if (closed) return;
        const message = bridgeMessageSchema.parse(input);
        switch (message.kind) {
            case 'call': void handleCall(message).catch(() => { void dispose(false); }); break;
            case 'return':
            case 'error': {
                const request = pending.get(message.id);
                if (!request) return;
                pending.delete(message.id);
                const retainsHandle = message.kind === 'return' && hasReferences(message.value);
                if ((!request.retain && !retainsHandle) || message.kind === 'error') release(request.scope);
                if (message.kind === 'error') request.reject(decodeError(message.error));
                else {
                    const result = decode(message.value, retainsHandle ? () => release(request.scope) : undefined);
                    request.resolve(result);
                }
                break;
            }
            case 'abort': receivedSignals.get(message.id)?.abort(message.reason === undefined ? undefined : decode(message.reason)); break;
            case 'release': for (const key of message.ids) receivedSignals.delete(key); break;
            case 'close': void dispose(false); break;
        }
    }
    let disposal: Promise<void> | undefined;
    function dispose(notify = true): Promise<void> {
        if (disposal) return disposal;
        closed = true;
        signal?.removeEventListener('abort', onAbort);
        if (notify) { try { send({ kind: 'close' }); } catch { /* The transport may already be gone. */ } }
        for (const controller of receivedSignals.values()) controller.abort();
        receivedSignals.clear();
        for (const request of pending.values()) { release(request.scope); request.reject(closedError()); }
        pending.clear();
        const cleanup = [...subscriptions].map(async (subscription) => { await subscription.dispose(); });
        subscriptions.clear();
        for (const scope of scopes) release(scope);
        methods.clear();
        disposal = Promise.allSettled(cleanup).then((results) => {
            const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), 'Background service subscriptions failed to settle');
        });
        void disposal.catch(() => {});
        return disposal;
    }
    const onAbort = () => { void dispose(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) void dispose();
    return { encode: (value: unknown) => encode(value, newScope()), decode, receive, dispose: () => dispose() };
}

export function createBackgroundServiceProcessServiceHost(params: Readonly<{
    /** Only daemon-admitted roots supplied here are callable. There is no dynamic discovery. */
    services: Readonly<Record<string, unknown>>;
    send: Send;
    signal?: AbortSignal;
}>) {
    const peer = createPeer(params.send, params.signal);
    return { description: peer.encode(params.services), receive: peer.receive, dispose: peer.dispose };
}

export function createBackgroundServiceProcessServiceClient<T extends Readonly<Record<string, unknown>> = ProxiedServices>(params: Readonly<{
    description: BackgroundServiceProcessBridgeValue;
    send: Send;
    signal?: AbortSignal;
}>): Readonly<{ services: T; receive(message: unknown): void; dispose(): Promise<void> }> {
    const peer = createPeer(params.send, params.signal);
    // The private transport is admitted by the parent bootstrap; this cast restores its exact supplied service roots.
    return { services: peer.decode(bridgeValueSchema.parse(params.description)) as T, receive: peer.receive, dispose: peer.dispose };
}
