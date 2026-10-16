export type WorkosPortalReturnController = Readonly<{
    markOpened: () => void;
    consumeReturn: () => boolean;
}>;

/** Connections whose portal opened before their own page mounted (setup opens it, then shows the page). */
const openedBeforeMount = new Set<string>();

export function markWorkosPortalOpenedFor(connectionId: string): void {
    openedBeforeMount.add(connectionId);
}

export function createWorkosPortalReturnController(connectionId?: string): WorkosPortalReturnController {
    let awaiting = false;
    return Object.freeze({
        markOpened: () => { awaiting = true; },
        consumeReturn: () => {
            if (connectionId !== undefined && openedBeforeMount.delete(connectionId)) awaiting = true;
            if (!awaiting) return false;
            awaiting = false;
            return true;
        },
    });
}
