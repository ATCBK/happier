type SyncPublicApi = typeof import('@/sync/sync')['sync'];

/** Shell fixtures prepare draft persistence before rendering; no remote draft work remains. */
export function createSessionDraftSurfaceSyncBoundary(): Pick<SyncPublicApi, 'prepareSessionDraftSurface'> {
    return { prepareSessionDraftSurface: async lifetime => lifetime.isCurrent() };
}

export type AcceptedExternalSessionTailCursorSyncBoundary = Pick<
    SyncPublicApi,
    'getAcceptedExternalSessionTailCursor' | 'subscribeAcceptedExternalSessionTailCursor'
>;

export function createAcceptedExternalSessionTailCursorSyncBoundary(
    overrides: Partial<AcceptedExternalSessionTailCursorSyncBoundary> = {},
): AcceptedExternalSessionTailCursorSyncBoundary {
    return {
        getAcceptedExternalSessionTailCursor: () => null,
        subscribeAcceptedExternalSessionTailCursor: () => () => {},
        ...overrides,
    };
}

/** Surfaces that show Sessions demand their content; a fixture settles that demand without a Home. */
export function createSessionListHydrationSyncBoundary(): Pick<SyncPublicApi, 'hydrateSessionListRows'> {
    return { hydrateSessionListRows: async () => undefined };
}
