import {
  useSessionMachineDisplayIdentity,
  useSessionMachineTarget,
} from '@/components/sessions/model/useSessionMachineTarget';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { t } from '@/text';

import { useOptionalSessionViewerController } from './SessionViewerController';
import type { SessionViewerSource } from './sessionViewerPresentation';

/**
 * The Machine a Session's Computer is on, named even while it cannot be reached: the viewer then
 * says so itself instead of the Computer vanishing with the Machine. Null only when the Session
 * has no Machine at all.
 */
export function useSessionViewerMachineId(
  sessionId: string,
  serverId: string | null,
): string | null {
  const reachable =
    useSessionMachineTarget(sessionId, serverId)?.machineId ?? null;
  const named = useSessionMachineDisplayIdentity(sessionId, serverId).machineId;
  return reachable ?? (named || null);
}

/**
 * The Machine the viewer's source runs on, as every part of the viewer names it (the controls'
 * identity capsule and the frame's own label): the name the source's owner states, else the
 * Session's Machine. A source that publishes no name (the Browser) is still on that Machine.
 */
export function useSessionViewerMachine(
  sessionId: string,
  serverId: string | null,
  source: SessionViewerSource,
): Readonly<{ name: string; online: boolean; targetTitle: string | null }> {
  const facts = useOptionalSessionViewerController()?.facts[source];
  const stated = facts?.machineName ?? null;
  const machineId = useSessionViewerMachineId(sessionId, serverId);
  const presence = useMachinePresenceSummary(serverId, machineId);
  return {
    name: stated ?? presence.name ?? machineId ?? '',
    online: presence.reachability === 'reachable',
    targetTitle: facts?.targetTitle ?? null,
  };
}

/** Source identity shared by the switch and the accessible frame name in every picture state. */
export function resolveSessionViewerSourceLabel(
  source: SessionViewerSource,
  targetTitle?: string | null,
): string {
  return targetTitle?.trim() || t(
    source === 'computer'
      ? 'computerUse.presentation.sourceComputer'
      : 'computerUse.presentation.sourceBrowser',
  );
}

/** The frame's accessible name: what is watched and where, never a dangling "on". */
export function resolveSessionViewerWatchingLabel(
  source: SessionViewerSource,
  machineName: string,
  targetTitle?: string | null,
): string {
  const sourceLabel = resolveSessionViewerSourceLabel(source, targetTitle);
  return machineName
    ? t('computerUse.presentation.watchingA11y', { source: sourceLabel, machine: machineName })
    : t('computerUse.presentation.watchingSourceA11y', { source: sourceLabel });
}
