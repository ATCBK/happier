/** The admitted v1 process service set, shared by admission and child binding. */
export const BACKGROUND_SERVICE_PROCESS_LOCAL_SERVICE_IDS = ['logger', 'fs', 'http', 'exec'] as const;
export const BACKGROUND_SERVICE_PROCESS_PROXIED_SERVICE_IDS = ['storage', 'settings', 'events', 'sessions', 'actions'] as const;
export const BACKGROUND_SERVICE_PROCESS_SUPPORTED_SERVICE_IDS: readonly string[] = [
    ...BACKGROUND_SERVICE_PROCESS_LOCAL_SERVICE_IDS,
    ...BACKGROUND_SERVICE_PROCESS_PROXIED_SERVICE_IDS,
];

/** Project exactly the admitted v1 SDK proxy surfaces; Account collections are not part of v1. */
export function projectBackgroundServiceProcessProxiedServices(services: object): Readonly<Record<string, unknown>> {
    const projected = Object.fromEntries(BACKGROUND_SERVICE_PROCESS_PROXIED_SERVICE_IDS.flatMap((serviceId): Array<readonly [string, unknown]> => {
        if (!Object.hasOwn(services, serviceId)) return [];
        const service: unknown = Reflect.get(services, serviceId);
        if (serviceId !== 'storage') return [[serviceId, service]];
        if (typeof service !== 'object' || service === null) return [];
        return [[serviceId, Object.fromEntries(['ephemeral', 'daemonSession', 'daemon'].flatMap((scope) => (
            Object.hasOwn(service, scope) ? [[scope, Reflect.get(service, scope)]] : []
        )))]];
    }));
    const availability: unknown = Reflect.get(services, 'availability');
    return Object.freeze({
        ...projected,
        ...(typeof availability === 'function' ? {
            __serviceAvailability: Object.fromEntries(BACKGROUND_SERVICE_PROCESS_PROXIED_SERVICE_IDS.map((serviceId) => (
                [serviceId, Reflect.apply(availability, services, [serviceId])]
            ))),
        } : {}),
    });
}
