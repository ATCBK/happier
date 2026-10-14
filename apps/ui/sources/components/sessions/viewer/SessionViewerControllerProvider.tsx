import * as React from 'react';
import type { FrameRect } from '@happier-dev/plugin-ui/presentation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { readSessionComposerPresentationTargetAtAddress } from '@/components/sessions/presentation/sessionComposerPresentationTargets';

import {
  createSessionViewerPresenceStore,
  NO_SESSION_VIEWER_INSET,
  SessionViewerControllerContext,
  SessionViewerReadingInsetContext,
  type SessionViewerController,
  type SessionViewerSourceFacts,
} from './SessionViewerController';
import {
  CLOSED_SESSION_VIEWER,
  resolveSessionViewerPresentation,
  type SessionViewerLocalIntent,
  type SessionViewerPresentationPort,
  type SessionViewerPresentationState,
  type SessionViewerSource,
} from './sessionViewerPresentation';

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
      /** Desktop dock: the pane presentation of the same retained body. */
      openDocked: (source: SessionViewerSource) => void;
    }>
  >,
): React.ReactElement {
  const [state, setState] = React.useState<SessionViewerPresentationState>(
    CLOSED_SESSION_VIEWER,
  );
  const [facts, setFacts] = React.useState<SessionViewerController['facts']>(
    {},
  );
  const [presence] = React.useState(createSessionViewerPresenceStore);
  const [readingInset, setReadingInsetState] =
    React.useState<Readonly<{ left: number; right: number }>>(NO_SESSION_VIEWER_INSET);
  const stateRef = React.useRef(state);
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
    const { phone, canPresentSource, openDocked } = inputRef.current;
    const next = resolveSessionViewerPresentation(stateRef.current, intent, {
      phone,
      canPresentSource,
    });
    if (next.result.status === 'applied') {
      stateRef.current = next.state;
      setState(next.state);
      if (!phone && intent.kind === 'viewer.dock' && next.state.source)
        openDocked(next.state.source);
    } else if (
      next.result.status === 'unchanged' &&
      !phone &&
      intent.kind === 'viewer.open' &&
      next.state.mode === 'docked'
    ) {
      // Docked on desktop means its pane presents it: reopening reveals that pane again.
      openDocked(intent.source);
    }
    return next.result;
  }, []);
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
    const current = stateRef.current;
    if (current.rect === rect) return;
    stateRef.current = {
      ...current,
      rect,
      width: rect?.width ?? current.width,
    };
    setState(stateRef.current);
  }, []);
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
    (inset: Readonly<{ left: number; right: number }>) => {
      setReadingInsetState((current) =>
        current.left === inset.left && current.right === inset.right
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
      state,
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
    }),
    [
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
      state,
    ],
  );
  const effectiveInset = state.mode === 'floating' ? readingInset : NO_SESSION_VIEWER_INSET;
  return (
    <SessionViewerControllerContext.Provider value={value}>
      <SessionViewerReadingInsetContext.Provider value={effectiveInset}>
        {props.children}
      </SessionViewerReadingInsetContext.Provider>
    </SessionViewerControllerContext.Provider>
  );
}
