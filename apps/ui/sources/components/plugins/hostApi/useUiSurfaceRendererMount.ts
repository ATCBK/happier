import * as React from 'react';

import { createUiSurfaceMountIdentity } from './createUiSurfaceMountIdentity';
import { useUiSurfaceOwnerLifetime } from './useUiSurfaceOwnerLifetime';

type RendererLifetime = Readonly<{
    isCurrent: () => boolean;
    onRetire: (listener: () => void) => Readonly<{ dispose: () => void }>;
}>;

/** Physical renderer lifetime only; admission and authority remain with the caller. */
export function useUiSurfaceRendererMount(input: Readonly<{
    lifetime: RendererLifetime;
    mountKey?: string;
    instanceId?: string | null;
    interactionEnabled: boolean;
    focusEligible: boolean;
}>) {
    const mount = React.useMemo(() => {
        const mounted = {
            identity: input.instanceId === null ? null : createUiSurfaceMountIdentity(input.instanceId),
            controller: new AbortController(),
            retired: false,
            retirement: null as ReturnType<RendererLifetime['onRetire']> | null,
        };
        return Object.assign(mounted, {
            isCurrent: () => !mounted.retired && !mounted.controller.signal.aborted && input.lifetime.isCurrent(),
            retire: () => { mounted.retired = true; },
            dispose: () => {
                mounted.retired = true;
                mounted.retirement?.dispose();
                mounted.retirement = null;
                mounted.controller.abort();
            },
        });
    }, [input.instanceId, input.lifetime, input.mountKey]);
    const eligibility = React.useRef(input);
    eligibility.current = input;
    const isCurrent = mount.isCurrent;
    const isFocusEligible = React.useCallback(() => (
        isCurrent() && eligibility.current.interactionEnabled && eligibility.current.focusEligible
    ), [isCurrent]);
    useUiSurfaceOwnerLifetime(mount);
    React.useLayoutEffect(() => {
        mount.retirement ??= input.lifetime.onRetire(mount.dispose);
        if (!input.lifetime.isCurrent()) mount.dispose();
    }, [input.lifetime, mount]);
    return { identity: mount.identity, signal: mount.controller.signal, isCurrent, isFocusEligible };
}
