import { useCallback, useEffect, useReducer, useState } from 'react';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { usePluginHostApi, usePluginHostReadiness, usePluginSurfaceActivity, usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';

export type PersonalTaskOrder = Extract<PluginActionResultById['tasks.internal.list'], { status: 'ok' }>;

/** A read-only projection of the existing Account index, scoped to this mounted authority. */
export function usePersonalTaskOrder(enabled: boolean, pass: number) {
  const host = usePluginHostApi();
  const scope = usePluginUiEphemeralSharedScope();
  const readiness = usePluginHostReadiness(false);
  const activity = usePluginSurfaceActivity();
  const [revision, invalidate] = useReducer((value: number) => value + 1, 0);
  const [read, setRead] = useState<Readonly<{ scope: typeof scope; value: PersonalTaskOrder | null; available: boolean }> | null>(null);
  useEffect(() => {
    if (!enabled || scope === null || !activity.active || readiness.pending) return;
    const cancellation = new AbortController();
    const fail = () => {
      if (!cancellation.signal.aborted) setRead(previous => ({ scope, available: false, value: previous?.scope === scope ? previous.value : null }));
    };
    void host.executeAction('tasks.internal.list', {}, { signal: cancellation.signal }).then(result => {
      if (cancellation.signal.aborted) return;
      if (result.status !== 'ok') { fail(); return; }
      setRead({ scope, value: result, available: true });
    }).catch(fail);
    return () => cancellation.abort();
  }, [host, scope, enabled, activity.active, readiness.pending, readiness.revision, pass, revision]);
  const current = enabled && scope !== null && read?.scope === scope ? read : null;
  // Settlement only invalidates this read; the host remains the sole writer.
  const onDropOutcome = useCallback(() => { invalidate(); }, []);
  return { value: current?.value ?? null, available: current?.available === true, onDropOutcome };
}
