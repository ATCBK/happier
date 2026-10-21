import type { Tx } from '@/storage/inTx';

/** Observe model acquisitions at the real database boundary without replacing queries. */
export function observePrismaReads(tx: Tx, models: readonly (keyof Tx)[]) {
    const reads: string[] = [];
    const observed = new Proxy(tx, {
        get(target, model, receiver) {
            const delegate: unknown = Reflect.get(target, model, receiver);
            if (typeof delegate === 'function') return delegate.bind(target);
            if (!models.some(candidate => candidate === model) || delegate === null || typeof delegate !== 'object') return delegate;
            return new Proxy(delegate, {
                get(owner, operation, delegateReceiver) {
                    const method: unknown = Reflect.get(owner, operation, delegateReceiver);
                    if (typeof method !== 'function') return method;
                    return (...args: unknown[]) => {
                        if (typeof operation === 'string' && operation.startsWith('find')) reads.push(`${String(model)}.${operation}`);
                        return Reflect.apply(method, owner, args);
                    };
                },
            });
        },
    });
    return { tx: observed, reads };
}
