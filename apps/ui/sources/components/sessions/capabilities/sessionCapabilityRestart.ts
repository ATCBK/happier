import * as React from 'react';

import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';

import { sessionCapabilityApplyBadge } from './sessionCapabilityApplyBadge';
import type { SessionCapabilityApplyNotice } from './sessionCapabilityApplyNotice';

export type SessionCapabilityRestartState = 'idle' | 'restarting' | 'failed';

/**
 * D34: a launch the runner cannot restart itself (`restart_to_apply`, `restartBy: 'user'`) makes the one
 * apply line a Restart action. It composes the existing session stop and the existing explicit resume
 * (whose new runner reads the stored selection); nothing new owns the session's lifecycle. A failed stop
 * or resume leaves the change saved and says "Couldn't restart · Try again".
 */
export function useSessionCapabilityRestart(
  params: Readonly<{
    notice: SessionCapabilityApplyNotice | null;
    /** The session Action's stop; `true` once the session has stopped. */
    stop: () => Promise<boolean>;
    /** The incumbent explicit resume; `true` once the session runs again. */
    resume: () => Promise<boolean>;
  }>,
): Readonly<{
  state: SessionCapabilityRestartState;
  restart: () => Promise<void>;
  badge: AgentInputStatusBadge | null;
}> {
  const { notice, stop, resume } = params;
  const [state, setState] =
    React.useState<SessionCapabilityRestartState>('idle');
  const running = React.useRef(false);
  const enabled = notice?.restart === 'enabled';
  const restart = React.useCallback(async () => {
    if (running.current || !enabled) return;
    running.current = true;
    setState('restarting');
    try {
      const restarted = (await stop()) && (await resume());
      setState(restarted ? 'idle' : 'failed');
    } catch {
      setState('failed');
    } finally {
      running.current = false;
    }
  }, [enabled, stop, resume]);
  // A settled change (or a new one) starts from the producer's own words again.
  const noticeKey = notice ? `${notice.key}:${notice.text}` : null;
  React.useEffect(() => {
    if (!running.current) setState('idle');
  }, [noticeKey]);
  const badge = React.useMemo(
    () =>
      sessionCapabilityApplyBadge(notice, {
        restart: { state, onPress: restart },
      }),
    [notice, state, restart],
  );
  return { state, restart, badge };
}
