import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { markAccountChanged } from "./markAccountChanged";

/** Commit a real cursor publication before a selected SQL boundary on each writer attempt. */
export async function withAccountPublicationBeforeTransactionSql<T>(
    accountId: string,
    matches: (sql: string) => boolean,
    operation: () => Promise<T>,
): Promise<Readonly<{ result: T; advances: number }>> {
    const original = db.$transaction;
    const peerScope = new AsyncLocalStorage<boolean>();
    let advances = 0;
    // Interpose only at Prisma's actual SQL boundary: domain logic and both
    // transactions, including publication and retry handling, remain real.
    db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== "function" || peerScope.getStore()) return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [async (tx: Tx) => {
            let advanced = false;
            const query = tx.$queryRawUnsafe.bind(tx);
            return callback(new Proxy(tx, { get(owner, property, proxyReceiver) {
                if (property !== "$queryRawUnsafe") return Reflect.get(owner, property, proxyReceiver);
                return async (...values: Parameters<typeof query>) => {
                    if (!advanced && matches(values[0])) {
                        advanced = true;
                        await peerScope.run(true, () => inTx(async peer => {
                            await markAccountChanged(peer, { accountId, kind: "account", entityId: "cursor-peer" });
                        }));
                        advances++;
                    }
                    return query(...values);
                };
            } }));
        }, ...args.slice(1)]);
    } });
    try { return { result: await operation(), advances }; }
    finally { db.$transaction = original; }
}

interface QueryObservation {
    started(): void;
    settled(succeeded: boolean, error?: unknown): void;
}

/** Observe consumption without replacing Prisma's lazy query or fluent surface. */
export function observeLazyPrismaQuery(
    query: unknown,
    createObservation: () => QueryObservation,
    beforeQuery?: () => Promise<void>,
    aroundQuery?: (consume: () => Promise<unknown>) => Promise<unknown>,
): unknown {
    if (!query || typeof query !== 'object' || typeof Reflect.get(query, 'then') !== 'function') return query;
    let running: Promise<unknown> | undefined;
    const consume = () => new Promise<unknown>((resolve, reject) => {
        const observation = createObservation();
        observation.started();
        try {
            Reflect.apply(Reflect.get(query, 'then'), query, [
                (value: unknown) => { observation.settled(true); resolve(value); },
                (error: unknown) => { observation.settled(false, error); reject(error); },
            ]);
        } catch (error) {
            observation.settled(false, error);
            reject(error);
        }
    });
    // Keep the benchmark's no-hook timing and native consumption path intact.
    const execute = () => aroundQuery ? aroundQuery(consume) : consume();
    const run = () => running ??= beforeQuery
        ? Promise.resolve().then(beforeQuery).then(execute)
        : execute();
    return new Proxy(query, {
        get(target, property) {
            if (property === 'then' || property === 'catch' || property === 'finally') {
                return (...args: unknown[]) => {
                    const promise = run();
                    return Reflect.apply(Reflect.get(promise, property), promise, args);
                };
            }
            const value: unknown = Reflect.get(target, property, target);
            // Relation methods create another lazy Prisma query; transaction
            // requests keep their original receiver and transaction arguments.
            return typeof value === 'function'
                ? (...args: unknown[]) => observeLazyPrismaQuery(Reflect.apply(value, target, args), createObservation, beforeQuery, aroundQuery)
                : value;
        },
    });
}
