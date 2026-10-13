import * as React from 'react';

import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { Icon } from '@/components/ui/icons/Icon';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';

import type { SessionCapabilityApplyNotice } from './sessionCapabilityApplyNotice';

/**
 * The one composer status line for a session capability change (sheet, `$` pick, approved Agent request,
 * another device): the producer's words in the composer's existing status-badge slot. A user restart
 * (D34, visible Windows console) makes the line its own Restart action while the turn is settled.
 */
export function sessionCapabilityApplyBadge(
  notice: SessionCapabilityApplyNotice | null,
  options?: Readonly<{
    onRestart?: () => void;
  }>,
): AgentInputStatusBadge | null {
  if (!notice) return null;
  const failed = notice.key === 'cannotResume';
  const waiting =
    notice.key === 'offline' ||
    notice.key === 'restart' ||
    notice.key === 'restartTerminal';
  return {
    key: 'session-capabilities-apply',
    label: notice.text,
    testID: 'session-capabilities-apply',
    tone: failed ? 'warning' : 'neutral',
    emphasis: 'quiet',
    icon: (tint: string) =>
      normalizeNodeForView(
        <Icon
          name={
            failed ? 'warning-circle' : waiting ? 'clock' : 'arrows-clockwise'
          }
          size={14}
          color={tint}
        />,
      ),
    ...(notice.restart === 'enabled' && options?.onRestart
      ? { onPress: options.onRestart }
      : {}),
  };
}
