import * as React from 'react';

import { isDesktopHost } from '@/utils/platform/desktopHost';

import {
    getDesktopActivityOverlayWindowState,
    listenDesktopActivityOverlayWindowState,
    type DesktopActivityOverlayWindowStatePayload,
} from './desktopActivityOverlayBridge';
import { isDesktopActivityOverlayWindowContext } from './isDesktopActivityOverlayWindowContext';

function createDesktopActivityOverlayStateSignature(payload: DesktopActivityOverlayWindowStatePayload): string {
    return JSON.stringify(payload);
}

export function useDesktopActivityOverlayState(): DesktopActivityOverlayWindowStatePayload | null {
    const [state, setState] = React.useState<DesktopActivityOverlayWindowStatePayload | null>(null);

    React.useEffect(() => {
        if (!isDesktopHost() || !isDesktopActivityOverlayWindowContext()) {
            return () => {};
        }

        let disposed = false;
        let unlisten: (() => void) | null = null;
        let stateEventVersion = 0;
        const stateSignatureRef = { current: null as string | null };
        const applyState = (payload: DesktopActivityOverlayWindowStatePayload) => {
            if (disposed) return;
            const nextSignature = createDesktopActivityOverlayStateSignature(payload);
            if (stateSignatureRef.current === nextSignature) {
                return;
            }
            stateSignatureRef.current = nextSignature;
            setState(payload);
        };

        const reconcileState = async () => {
            const readEventVersion = stateEventVersion;
            try {
                const payload = await getDesktopActivityOverlayWindowState();
                // A native publication received during this read is newer than
                // its snapshot; preserve that event's window state.
                if (payload && stateEventVersion === readEventVersion) {
                    applyState(payload);
                }
            } catch {}
        };

        const initialStateRead = reconcileState();

        void listenDesktopActivityOverlayWindowState((payload) => {
            if (payload) {
                stateEventVersion += 1;
                applyState(payload);
            }
        }).then(async (dispose) => {
            if (disposed) {
                dispose();
                return;
            }
            unlisten = dispose;
            // Registration is asynchronous. Re-read after it and the initial
            // read settle to recover any state changed before listening began.
            await initialStateRead;
            if (!disposed) {
                await reconcileState();
            }
        }).catch(() => {});

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    return state;
}
