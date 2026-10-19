import * as React from 'react';
import type { FrameRect } from '@happier-dev/plugin-ui/presentation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { readSessionComposerPresentationTargetAtAddress } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { useSessionViewerPresentationState } from './SessionViewerDestinationScope';

import {
  createSessionViewerPresenceStore,
  NO_SESSION_VIEWER_INSET,
  SessionViewerControllerContext,
  SessionViewerReadingInsetContext,
  type SessionViewerController,
  type SessionViewerReadingInset,
  type SessionViewerSourceFacts,
} from './SessionViewerController';
import {
  resolveSessionViewerPresentation,
  type SessionViewerLocalIntent,
  type SessionViewerPresentationPort,
  type SessionViewerPresentationState,
  type SessionViewerSource,
} from './sessionViewerPresentation';

/** A floating desktop view occupies the phone's existing sticky slot during reflow. */
function projectViewportPresentation(state: SessionViewerPresentationState, phone: boolean): SessionViewerPresentationState {
  return phone && state.mode === 'floating' ? { ...state, mode: 'docked' } : state;
}

/**
 * The one mounted viewer presentation owner for a Session: which source is presented and how
 * (floating, expanded, docked, closed), plus the local geometry. It lives for the mounted Session
 * and is retired with it; target selection, control and stream lifetime stay with their owners.
 */
export function SessionViewerControllerProvider(
  props: React.PropsWithChildren<
    Readonly<{
      phone: boolean;
      sessionId: string;
      serverId: string | null;
      canPresentSource: (source: SessionViewerSource) => boolean;
      /**
       * Where the docked body is presented: the desktop pane showing the same retained body, or on a
       * phone the Chat reading flow it docks into. Called when the presentation asks to reveal it.
       */
      openDocked: (source: SessionViewerSource) => void;
      /** Releases what `openDocked` revealed when the frame floats again, so the transcript reads underneath. */
      closeDocked?: (source: SessionViewerSource) => void;
    }>
  >,
): React.ReactElement {
  const { state, setState, readState } = useSessionViewerPresentationState(props.sessionId, props.serverId);
  // Keep the desktop placement while a narrow viewport presents the same source in reading flow.
  const presentedState = React.useMemo(() => projectViewportPresentation(state, props.phone), [props.phone, state]);
  const [facts, setFacts] = React.useState<SessionViewerController['facts']>(
    {},
  );
  const [presence] = React.useState(createSessionViewerPresenceStore);
  const [readingInset, setReadingInsetState] =
    React.useState<SessionViewerReadingInset>(NO_SESSION_VIEWER_INSET);
  const [floatFits, setFloatFits] = React.useState(false);
  const floatFitsRef = React.useRef(floatFits);
  floatFitsRef.current = floatFits;
  const inputRef = React.useRef(props);
  inputRef.current = props;

  const { binding: accountBinding } = useServerCredentialAccountScopeBinding(props.serverId);
  const semanticScope = React.useMemo(() => ({ lifetime: new AbortController() }), [props.sessionId, props.serverId]);
  React.useEffect(() => {
    // Strict-effects replay restarts this mounted lifecycle, not a retired scope's callbacks.
    if (semanticScope.lifetime.signal.aborted) semanticScope.lifetime = new AbortController();
    const lifetime = semanticScope.lifetime;
    return () => lifetime.abort();
  }, [semanticScope]);
  const applyPresentation = React.useCallback((intent: SessionViewerLocalIntent) => {
    const { phone, canPresentSource, openDocked, closeDocked } = inputRef.current;
    // Floating again is the placement owner's call: only while the frame fits where it would rest.
    if (intent.kind === 'viewer.float' && !floatFitsRef.current) return { status: 'unavailable' } as const;
    const next = resolveSessionViewerPresentation(readState(), intent, {
      phone,
      canPresentSource,
    });
    if (next.result.status === 'applied') {
      setState(next.state);
      if (!phone && intent.kind === 'viewer.dock' && next.state.source)
        openDocked(next.state.source);
      // A phone's dock is Chat's reading flow: there is no pane to release.
      if (!phone && intent.kind === 'viewer.float' && next.state.source)
        closeDocked?.(next.state.source);
    } else if (
      next.result.status === 'unchanged' &&
      !phone &&
      intent.kind === 'viewer.open' &&
      next.state.mode === 'docked'
    ) {
      // Docked on desktop means its pane presents it: reopening reveals that pane again.
      openDocked(intent.source);
    }
    // A phone's dock is the reading flow of Chat, which may not be the surface in view: every open
    // request, applied or already presented, reveals it.
    if (phone && intent.kind === 'viewer.open' && (next.result.status === 'applied' || next.result.status === 'unchanged'))
      openDocked(intent.source);
    return next.result;
  }, [readState, setState]);
  const executeAction = React.useMemo(() => createFrontDoorActionExecute(undefined, accountBinding ? {
    currentSessionPresentationApply: {
      serverId: accountBinding.serverId,
      accountId: accountBinding.accountId,
      sessionId: props.sessionId,
      isCurrent: () => accountBinding.isCurrent() && !semanticScope.lifetime.signal.aborted,
      apply: async ({ input, signal }) => {
        signal?.throwIfAborted();
        switch (input.intent.kind) {
          case 'viewer.open': case 'viewer.close': case 'viewer.source.select': case 'viewer.expand': case 'viewer.restore': {
            const outcome = applyPresentation(input.intent);
            if (outcome.status === 'applied' || outcome.status === 'unchanged') {
              const target = readSessionComposerPresentationTargetAtAddress({ serverId: accountBinding.serverId, sessionId: props.sessionId });
              return { status: outcome.status, revision: String(target?.revision ?? 0) };
            }
            const errorCode = outcome.status === 'invalidTarget' ? 'current_session_presentation_invalid_target'
              : outcome.status === 'notCurrent' ? 'current_session_presentation_not_current' : 'target_unavailable';
            return { ok: false, errorCode, error: errorCode };
          }
          default: return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        }
      },
    },
  } : undefined), [accountBinding, applyPresentation, props.sessionId, semanticScope]);
  const requestSemantic = React.useCallback<SessionViewerController['requestSemantic']>((intent) => {
    const signal = semanticScope.lifetime.signal;
    if (!props.serverId || !accountBinding?.isCurrent() || signal.aborted) {
      return Promise.resolve({ ok: false, errorCode: 'current_session_presentation_not_current', error: 'current_session_presentation_not_current' });
    }
    return executeAction('session.presentation.apply', { intent }, {
      surface: 'ui', serverId: props.serverId, defaultSessionId: props.sessionId, signal,
    });
  }, [accountBinding, executeAction, props.serverId, props.sessionId, semanticScope]);
  const apply: SessionViewerController['apply'] = applyPresentation;
  const setRect = React.useCallback((rect: FrameRect | null) => {
    const current = readState();
    if (current.rect === rect) return;
    setState({
      ...current,
      rect,
      width: rect?.width ?? current.width,
    });
  }, [readState, setState]);
  const publishFacts = React.useCallback(
    (source: SessionViewerSource, next: SessionViewerSourceFacts | null) => {
      setFacts((current) => {
        if (!next) {
          if (!current[source]) return current;
          const { [source]: _removed, ...rest } = current;
          return rest;
        }
        const previous = current[source];
        if (
          previous &&
          previous.machineName === next.machineName &&
          previous.targetTitle === next.targetTitle &&
          previous.personInControl === next.personInControl &&
          previous.watching === next.watching &&
          previous.aspectRatio === next.aspectRatio &&
          previous.chooseTarget === next.chooseTarget &&
          previous.resolveTargetPicker === next.resolveTargetPicker &&
          previous.stopSharing === next.stopSharing &&
          previous.navigation === next.navigation
        )
          return current;
        return { ...current, [source]: next };
      });
    },
    [],
  );
  const setReadingInset = React.useCallback(
    (inset: SessionViewerReadingInset) => {
      setReadingInsetState((current) =>
        current.left === inset.left &&
        current.right === inset.right &&
        current.centred.left === inset.centred.left &&
        current.centred.right === inset.centred.right &&
        current.centred.bottom === inset.centred.bottom
          ? current
          : inset,
      );
    },
    [],
  );
  const port = React.useMemo<SessionViewerPresentationPort>(
    () => ({ apply: applyPresentation }),
    [applyPresentation],
  );
  const canPresentSource = props.canPresentSource;
  const value = React.useMemo<SessionViewerController>(
    () => ({
      state: presentedState,
      phone: props.phone,
      serverId: props.serverId,
      apply,
      requestSemantic,
      port,
      canPresentSource,
      setRect,
      facts,
      publishFacts,
      presence,
      setReadingInset,
      floatFits,
      setFloatFits,
    }),
    [
      floatFits,
      apply,
      requestSemantic,
      canPresentSource,
      facts,
      port,
      props.phone,
      props.serverId,
      presence,
      publishFacts,
      setReadingInset,
      setRect,
      presentedState,
    ],
  );
  const effectiveInset = presentedState.mode === 'floating' ? readingInset : NO_SESSION_VIEWER_INSET;
  return (
    <SessionViewerControllerContext.Provider value={value}>
      <SessionViewerReadingInsetContext.Provider value={effectiveInset}>
        {props.children}
      </SessionViewerReadingInsetContext.Provider>
    </SessionViewerControllerContext.Provider>
  );
}
