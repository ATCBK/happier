import type { Tx } from '@/storage/inTx';

/** Observe model acquisitions at the real database boundary without replacing queries. */
export function observePrismaReads(tx: Tx, models: readonly (keyof Tx)[]) {
    const reads: string[] = [];
    const rows: Array<{ model: string; ids: string[] }> = [];
    const observed = new Proxy(tx, {
        get(target, model, receiver) {
            const delegate: unknown = Reflect.get(target, model, receiver);
            if (typeof delegate === 'function') return delegate.bind(target);
            if (!models.some(candidate => candidate === model) || delegate === null || typeof delegate !== 'object') return delegate;
            return new Proxy(delegate, {
                get(owner, operation, delegateReceiver) {
                    const method: unknown = Reflect.get(owner, operation, delegateReceiver);
                    if (typeof method !== 'function') return method;
                    return async (...args: unknown[]) => {
                        const reading = typeof operation === 'string' && operation.startsWith('find');
                        if (reading) reads.push(`${String(model)}.${operation}`);
                        const result: unknown = await Reflect.apply(method, owner, args);
                        if (reading) rows.push({ model: String(model), ids: (Array.isArray(result) ? result : [result]).flatMap(row => {
                            if (!row || typeof row !== 'object') return [];
                            if ('recipientAccountId' in row && typeof row.recipientAccountId === 'string') return [row.recipientAccountId];
                            return 'id' in row && typeof row.id === 'string' ? [row.id] : [];
                        }) });
                        return result;
                    };
                },
            });
        },
    });
    return { tx: observed, reads, rows };
}
