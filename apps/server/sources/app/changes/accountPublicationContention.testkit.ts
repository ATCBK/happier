interface QueryObservation {
    started(): void;
    settled(succeeded: boolean): void;
}

/** Observe consumption without replacing Prisma's lazy query or fluent surface. */
export function observeLazyPrismaQuery(query: unknown, createObservation: () => QueryObservation): unknown {
    if (!query || typeof query !== 'object' || typeof Reflect.get(query, 'then') !== 'function') return query;
    let running: Promise<unknown> | undefined;
    const run = () => running ??= new Promise<unknown>((resolve, reject) => {
        const observation = createObservation();
        observation.started();
        try {
            Reflect.apply(Reflect.get(query, 'then'), query, [
                (value: unknown) => { observation.settled(true); resolve(value); },
                (error: unknown) => { observation.settled(false); reject(error); },
            ]);
        } catch (error) {
            observation.settled(false);
            reject(error);
        }
    });
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
                ? (...args: unknown[]) => observeLazyPrismaQuery(Reflect.apply(value, target, args), createObservation)
                : value;
        },
    });
}
