import * as React from 'react';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { BackdropCanvasProps } from './backdropCanvas.types';

type CanvasRenderGeometry = Pick<BackdropCanvasProps, 'size' | 'span' | 'horizon'>;

export function useCanvasRenderState(geometry: CanvasRenderGeometry, source?: BackdropCanvasProps['source']) {
    const activelyViewed = useHostActivelyViewed();
    const presented = useLayoutPresentationActive();
    const visible = activelyViewed && presented;
    // Every frame-dependent crop input settles together. A new source starts with its own geometry:
    // its source horizon must never be used to crop the preceding picture (or vice versa).
    const [frame, setFrame] = React.useState({ geometry, source });
    if (source !== frame.source) setFrame({ geometry, source });
    const settled = frame.geometry;
    const { size, span, horizon } = geometry;
    React.useEffect(() => {
        if (!visible || (size.width === settled.size.width && size.height === settled.size.height
            && span?.x === settled.span?.x && span?.y === settled.span?.y
            && span?.W === settled.span?.W && span?.H === settled.span?.H
            && horizon?.src === settled.horizon?.src && horizon?.at === settled.horizon?.at)) return;
        const timer = setTimeout(() => setFrame({ geometry, source }), 120);
        return () => clearTimeout(timer);
    }, [settled, source, size.height, size.width, span?.x, span?.y, span?.W, span?.H, horizon?.src, horizon?.at, visible]);
    return { visible, geometry: settled };
}
