import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from 'react';
import type { PluginUiHostApi, SurfaceContext } from '@happier-dev/plugin-sdk/ui';

/** Host-owned loading plus the committed re-acquisition signal for mounted reads. */
export type PluginUiHostReadiness = Readonly<{
  pending: boolean;
  /** Exact host execution admission; omitted by hosts without this observation. */
  ready?: boolean;
  /** Changes only when host prerequisites settle or execution is re-admitted. */
  revision: number;
}>;

type HostReadinessProjection = PluginUiHostReadiness & Readonly<{ requester: PluginUiHostReadiness }>;
const UNSPECIFIED: HostReadinessProjection = Object.freeze({ pending: false, revision: 0,
  requester: Object.freeze({ pending: false, ready: true, revision: 0 }) });
const ReadinessContext = createContext<HostReadinessProjection>(UNSPECIFIED);
/** @internal Carries the same read owner into host-rendered panes. */
export const PLUGIN_UI_HOST_READINESS_CONTEXT_INTERNAL = ReadinessContext;

/** Private projection of the one mounted host's context; never execution authority. */
export function PluginUiHostReadinessProviderInternal(props: Readonly<{
  hostApi: PluginUiHostApi;
  context: SurfaceContext;
  children?: ReactNode;
}>) {
  const pending = props.context.machineConnectionPending === true;
  const requesterReady = props.context.requesterExecutionReady !== false;
  const ready = requesterReady ? props.context.machineExecutionReady : false;
  const [observed, setObserved] = useState(() => ({ hostApi: props.hostApi, pending, ready, requesterReady,
    revision: 0, requesterRevision: 0 }));
  if (observed.hostApi !== props.hostApi || observed.pending !== pending || observed.ready !== ready
    || observed.requesterReady !== requesterReady) {
    const replaced = observed.hostApi !== props.hostApi;
    const readmitted = (!observed.ready && ready === true)
      || (observed.pending && !pending && ready !== false);
    setObserved({ hostApi: props.hostApi, pending, ready, requesterReady,
      revision: replaced ? 0 : observed.revision + (readmitted ? 1 : 0),
      requesterRevision: replaced ? 0 : observed.requesterRevision + (!observed.requesterReady && requesterReady ? 1 : 0) });
  }
  const requester = useMemo(() => Object.freeze({ pending: false, ready: requesterReady,
    revision: observed.requesterRevision }), [requesterReady, observed.requesterRevision]);
  const value = useMemo(() => Object.freeze({ pending, ...(ready === undefined ? {} : { ready }),
    revision: observed.revision, requester }), [pending, ready, observed.revision, requester]);
  return createElement(ReadinessContext.Provider, { value }, props.children);
}

/**
 * Shared read lifecycle. Defer Machine reads while pending or ready is false and re-acquire on
 * revision changes. A settled outage does not advance the revision: Retry stays
 * caller-owned. Account-local reads wait for their requester, never an unrelated
 * Machine, and reacquire only when that requester's admission returns.
 */
export function usePluginHostReadiness(machineBound = true): PluginUiHostReadiness {
  const readiness = useContext(ReadinessContext);
  const selected = machineBound ? readiness : readiness.requester;
  const { pending, ready, revision } = selected;
  return useMemo(() => Object.freeze({ pending, ...(ready === undefined ? {} : { ready }),
    revision }), [pending, ready, revision]);
}
