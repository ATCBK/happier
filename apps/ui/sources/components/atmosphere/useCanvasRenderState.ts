import * as React from 'react';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

export function useCanvasRenderState(size: { width: number; height: number }) {
    const activelyViewed = useHostActivelyViewed();
    const presented = useLayoutPresentationActive();
    const visible = activelyViewed && presented;
    const [settled, setSettled] = React.useState(size);
    React.useEffect(() => {
        if (!visible || (size.width === settled.width && size.height === settled.height)) return;
        const timer = setTimeout(() => setSettled(size), 120);
        return () => clearTimeout(timer);
    }, [settled.height, settled.width, size.height, size.width, visible]);
    return { visible, size: settled };
}
