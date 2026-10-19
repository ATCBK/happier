import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from 'react';
import type { PluginUiHostApi, SurfaceContext } from '@happier-dev/plugin-sdk/ui';

/** Host-owned loading plus the committed re-acquisition signal for mounted reads. */
export type PluginUiHostReadiness = Readonly<{
  pending: boolean;
  /** Changes only when host prerequisites settle or execution is re-admitted. */
  revision: number;
}>;

const UNSPECIFIED: PluginUiHostReadiness = Object.freeze({ pending: false, revision: 0 });
const ReadinessContext = createContext<PluginUiHostReadiness>(UNSPECIFIED);
/** @internal Carries the same read owner into host-rendered panes. */
export const PLUGIN_UI_HOST_READINESS_CONTEXT_INTERNAL = ReadinessContext;

/** Private projection of the one mounted host's context; never execution authority. */
export function PluginUiHostReadinessProviderInternal(props: Readonly<{
  hostApi: PluginUiHostApi;
  context: SurfaceContext;
  children?: ReactNode;
}>) {
  const pending = props.context.machineConnectionPending === true;
  const ready = props.context.machineExecutionReady;
  const [observed, setObserved] = useState(() => ({ hostApi: props.hostApi, pending, ready, revision: 0 }));
  if (observed.hostApi !== props.hostApi || observed.pending !== pending || observed.ready !== ready) {
    const replaced = observed.hostApi !== props.hostApi;
    const readmitted = (!observed.ready && ready === true)
      || (observed.pending && !pending && ready !== false);
    setObserved({ hostApi: props.hostApi, pending, ready,
      revision: replaced ? 0 : observed.revision + (readmitted ? 1 : 0) });
  }
  const value = useMemo(() => Object.freeze({ pending, revision: observed.revision }), [pending, observed.revision]);
  return createElement(ReadinessContext.Provider, { value }, props.children);
}

/**
 * Shared read lifecycle. Defer Machine reads while pending and re-acquire on
 * revision changes. A settled outage does not advance the revision: Retry stays
 * caller-owned. Account-local reads are never held behind Machine readiness,
 * but share re-acquisition when the mounted host's prerequisites settle.
 */
export function usePluginHostReadiness(machineBound = true): PluginUiHostReadiness {
  const readiness = useContext(ReadinessContext);
  const pending = machineBound && readiness.pending;
  return useMemo(() => Object.freeze({ pending, revision: readiness.revision }), [pending, readiness.revision]);
}
