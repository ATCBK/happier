import { useEffect, useRef } from 'react';
import { usePluginHostReadiness, type PluginUiHostReadiness } from '@happier-dev/plugin-ui';

import type { TriageRefreshTriggerV1 } from '../../refresh/refreshEligibility.js';

type RefreshTriageListWindowV1 = (trigger: TriageRefreshTriggerV1) => Promise<void>;

/**
 * Send the named page-view demands to this mount's existing list-window owner.
 *
 * The host is the physical-lifecycle owner and supplies one public `active`
 * fact for its retained plugin surface. This adapter deliberately observes
 * that fact instead of attaching browser/AppState listeners or retaining its
 * own activity history.
 * It owns no pacing, timer, scheduler or provider call — all three live in the
 * mounted list window that receives the resulting `view` demand.
 */
export function useTriageListWindowViewDemand(
  active: boolean,
  refresh: RefreshTriageListWindowV1,
  readClientReadiness?: PluginUiHostReadiness,
): void {
  const ownReadiness = usePluginHostReadiness(false);
  const readiness = readClientReadiness ?? ownReadiness;
  const previous = useRef<Readonly<{
    active: boolean;
    refresh: RefreshTriageListWindowV1;
    readiness: PluginUiHostReadiness;
  }> | null>(null);

  useEffect(() => {
    const preceding = previous.current;
    previous.current = Object.freeze({ active, refresh, readiness });

    // A new refresh callback is a new host-scoped mounted window. It receives
    // its own initial demand even when the preceding surface was active. For a
    // retained window, an inactive -> active edge is a new view demand;
    // the shared read owner can also require re-acquisition after admission.
    const mountOrScopeChanged = preceding === null || preceding.refresh !== refresh;
    const regainedActivity = preceding !== null && !preceding.active && active;
    const reacquire = preceding !== null && preceding.readiness !== readiness;
    // A retained inactive surface must stay demand-silent. The host's active
    // fact gates both view demand and the shared owner's re-acquisition.
    // Readiness is supplied by the host, independently from public activity.
    // Hand the Account read's readiness edge to the same window/coalescing owner.
    // Nested sources decide their own execution placement, not this page demand.
    if (!active || readiness.pending || (!mountOrScopeChanged && !regainedActivity && !reacquire)) return;

    void refresh(reacquire ? 'manual' : 'view');
  }, [active, refresh, readiness]);
}
