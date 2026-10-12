import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';

const SoftSurfacesSpecimen = retryableLazy(() => import('@/components/dev/SoftSurfacesSpecimen'));

/** Static dev-only QA entry, outside authenticated runtime mounts. */
export default function SoftSurfacesDevScreen() {
    if (!isDevRouteEnabled()) return null;
    return <React.Suspense fallback={null}><SoftSurfacesSpecimen /></React.Suspense>;
}
