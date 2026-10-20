import {
    readDocumentFocusReturnTarget,
    restoreFocusToBestTarget,
    type FocusReturnRef,
    type FocusReturnMutableRef,
    type FocusReturnTarget,
} from '@/keyboard/focusReturn';

export type PaneOverlayFocusSurface = 'bottom' | 'details' | 'right' | 'main';
export type DetailsTabReturnKind = 'pane' | 'route';
export type DetailsTabFocusOrigin = Readonly<{
    focusReturnRef?: FocusReturnRef;
    onReturn?: (kind: DetailsTabReturnKind) => void;
}>;

export type PaneOverlayFocusReturnOwner = Readonly<{
    capture: (scopeId: string, surface: PaneOverlayFocusSurface, detailsTabKey?: string) => void;
    /** Records the native control that originated the next pane command. */
    recordNativeFocusTarget: (scopeId: string, target: unknown) => void;
    clear: (scopeId: string, surface: PaneOverlayFocusSurface) => void;
    clearAll: () => void;
    getRef: (scopeId: string, surface: PaneOverlayFocusSurface, detailsTabKey?: string) => FocusReturnMutableRef;
    recordDetailsTabOrigin: (scopeId: string, tabKey: string, origin: DetailsTabFocusOrigin, kind: DetailsTabReturnKind) => void;
    /** Consume before a transition, restore after its DOM/native tree has committed. */
    takeDetailsTabReturn: (scopeId: string, tabKey: string | null, kind: DetailsTabReturnKind) => (() => void) | null;
    forgetDetailsTabOrigin: (scopeId: string, tabKey: string) => void;
}>;

type PaneOverlayFocusRefs = Record<PaneOverlayFocusSurface, FocusReturnMutableRef> & Readonly<{
    nativeCommandTarget: FocusReturnMutableRef;
    detailsTabs: Map<string, { ref: FocusReturnMutableRef; kind: DetailsTabReturnKind; onReturn?: DetailsTabFocusOrigin['onReturn'] }>;
    routeFileTabKey: { current: string | null };
}>;

/**
 * AppPane-local, non-persistent focus handoffs for overlays whose opening
 * command will make their retained underlay inert. The command owner captures
 * synchronously; visual consumers only take the matching pending ref.
 */
export function createPaneOverlayFocusReturnOwner(): PaneOverlayFocusReturnOwner {
    const refsByScopeId = new Map<string, PaneOverlayFocusRefs>();

    const getRefs = (scopeId: string): PaneOverlayFocusRefs => {
        let refs = refsByScopeId.get(scopeId);
        if (!refs) {
            refs = {
                bottom: { current: null },
                details: { current: null },
                right: { current: null },
                main: { current: null },
                nativeCommandTarget: { current: null },
                detailsTabs: new Map(),
                routeFileTabKey: { current: null },
            };
            refsByScopeId.set(scopeId, refs);
        }
        return refs;
    };

    const getRef = (scopeId: string, surface: PaneOverlayFocusSurface, detailsTabKey?: string): FocusReturnMutableRef => {
        const refs = getRefs(scopeId);
        if (surface !== 'details' || !detailsTabKey) return refs[surface];
        let origin = refs.detailsTabs.get(detailsTabKey);
        if (!origin) {
            origin = { ref: { current: null }, kind: 'pane' };
            refs.detailsTabs.set(detailsTabKey, origin);
        }
        return origin.ref;
    };

    return {
        capture: (scopeId, surface, detailsTabKey) => {
            const ref = getRef(scopeId, surface, detailsTabKey);
            ref.current = typeof document === 'undefined'
                ? getRefs(scopeId).nativeCommandTarget.current
                : readDocumentFocusReturnTarget(document);
        },
        recordNativeFocusTarget: (scopeId, target) => {
            getRefs(scopeId).nativeCommandTarget.current = typeof target === 'number'
                && Number.isInteger(target)
                && target > 0
                ? target
                : null;
        },
        clear: (scopeId, surface) => {
            getRef(scopeId, surface).current = null;
        },
        clearAll: () => {
            for (const refs of refsByScopeId.values()) {
                refs.bottom.current = null;
                refs.details.current = null;
                refs.right.current = null;
                refs.main.current = null;
                refs.nativeCommandTarget.current = null;
                refs.detailsTabs.clear();
                refs.routeFileTabKey.current = null;
            }
        },
        getRef,
        recordDetailsTabOrigin: (scopeId, tabKey, origin, kind) => {
            const refs = getRefs(scopeId);
            const ref = getRef(scopeId, 'details', tabKey);
            ref.current = origin.focusReturnRef?.current;
            refs.detailsTabs.set(tabKey, { ref, kind, onReturn: origin.onReturn });
            if (kind === 'route') refs.routeFileTabKey.current = tabKey;
        },
        takeDetailsTabReturn: (scopeId, tabKey, kind) => {
            const refs = refsByScopeId.get(scopeId);
            const key = tabKey ?? refs?.routeFileTabKey.current;
            if (!refs || !key) return null;
            const origin = refs.detailsTabs.get(key);
            if (!origin || origin.kind !== kind) return null;
            refs.detailsTabs.delete(key);
            if (refs.routeFileTabKey.current === key) refs.routeFileTabKey.current = null;
            return () => {
                restoreFocusToBestTarget(origin.ref);
                origin.onReturn?.(kind);
            };
        },
        forgetDetailsTabOrigin: (scopeId, tabKey) => {
            const refs = refsByScopeId.get(scopeId);
            refs?.detailsTabs.delete(tabKey);
            if (refs?.routeFileTabKey.current === tabKey) refs.routeFileTabKey.current = null;
        },
    };
}
