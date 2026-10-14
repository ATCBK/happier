import * as React from 'react';

import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { Icon } from '@/components/ui/icons/Icon';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';

import type { SessionCapabilityApplyNotice } from './sessionCapabilityApplyNotice';
import type { SessionCapabilityRestartState } from './sessionCapabilityRestart';

export const SESSION_CAPABILITIES_APPLY_BADGE_KEY =
  'session-capabilities-apply';

/**
 * The one composer status line for a session capability change (sheet, `$` pick, approved Agent request,
 * another device): the producer's words in the composer's existing status-badge slot. A user restart
 * (D34, visible Windows console) makes the line its own Restart action while the turn is settled; while
 * a turn runs or an approval waits it stays the words alone.
 */
export function sessionCapabilityApplyBadge(
  notice: SessionCapabilityApplyNotice | null,
  options?: Readonly<{
    restart?: Readonly<{
      state: SessionCapabilityRestartState;
      onPress: () => void;
    }>;
  }>,
): AgentInputStatusBadge | null {
  if (!notice) return null;
  const restart = notice.restart === 'enabled' ? options?.restart : undefined;
  const failed = notice.key === 'cannotResume' || restart?.state === 'failed';
  const waiting =
    notice.key === 'offline' ||
    notice.key === 'restart' ||
    notice.key === 'restartTerminal';
  const label =
    restart?.state === 'restarting'
      ? t('capabilities.session.restart.restarting')
      : restart?.state === 'failed'
        ? t('capabilities.session.restart.failed')
        : notice.text;
  return {
    key: SESSION_CAPABILITIES_APPLY_BADGE_KEY,
    label,
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
    ...(restart && restart.state !== 'restarting'
      ? { onPress: restart.onPress }
      : {}),
  };
}
