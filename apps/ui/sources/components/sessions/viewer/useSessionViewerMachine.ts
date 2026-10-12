import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { t } from '@/text';

import { useOptionalSessionViewerController } from './SessionViewerController';
import type { SessionViewerSource } from './sessionViewerPresentation';

/**
 * The Machine the viewer's source runs on, as every part of the viewer names it (the controls'
 * identity capsule and the frame's own label): the name the source's owner states, else the
 * Session's Machine. A source that publishes no name (the Browser) is still on that Machine.
 */
export function useSessionViewerMachine(
  sessionId: string,
  serverId: string | null,
  source: SessionViewerSource,
): Readonly<{ name: string; online: boolean }> {
  const stated =
    useOptionalSessionViewerController()?.facts[source]?.machineName ?? null;
  const machineId =
    useSessionMachineTarget(sessionId, serverId)?.machineId ?? null;
  const presence = useMachinePresenceSummary(serverId, machineId);
  return {
    name: stated ?? presence.name ?? machineId ?? '',
    online: presence.reachability === 'reachable',
  };
}

/** The frame's accessible name: what is watched and where, never a dangling "on". */
export function resolveSessionViewerWatchingLabel(
  source: SessionViewerSource,
  machineName: string,
): string {
  const sourceLabel = t(
    source === 'computer'
      ? 'computerUse.viewer.sourceComputer'
      : 'computerUse.viewer.sourceBrowser',
  );
  return machineName
    ? t('computerUse.viewer.watchingA11y', { source: sourceLabel, machine: machineName })
    : t('computerUse.viewer.watchingSourceA11y', { source: sourceLabel });
}
