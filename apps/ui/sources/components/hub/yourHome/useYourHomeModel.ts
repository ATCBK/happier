import * as React from 'react';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';

import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import {
  forEachActivitySummaryCandidate,
  isActivityCandidateAwaitingPerson,
} from '@/activity/source/buildActivityOverviewFromSource';
import { useMountedActivityOverviewSummary } from '@/activity/source/useActivityOverview';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
  resolveDisplayMachineIdForSessionFromState,
  type SessionMachineTargetState,
} from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { storage, useActiveServerAccountScope, useAllMachines } from '@/sync/domains/state/storage';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';

import {
  buildYourHomeModel,
  type YourHomeModel,
  type YourHomeSessionState,
} from './yourHomeModel';

/**
 * Each machine's sessions on this Home, as the Activity summary's own walk classifies them: needs
 * you (its one "needs you" rule), working (its `isThinking`), else idle while the session is live.
 * A second projection of the one classifier, grouped by the machine the session runs on (the same
 * resolution as the machines' working counts), never a second definition of either state.
 */
export function buildYourHomeSessionStates(
  params: Readonly<{
    source: ActivityAttentionSource;
    nowMs: number;
    serverId: string;
    state: SessionMachineTargetState;
  }>,
): ReadonlyMap<string, readonly YourHomeSessionState[]> {
  const byMachine = new Map<string, YourHomeSessionState[]>();
  forEachActivitySummaryCandidate(
    { ...params, includeWarmSourceWhenNotReady: true },
    ({ entry, candidate }) => {
      if (entry.address.serverId !== params.serverId) return;
      const state: YourHomeSessionState | null =
        isActivityCandidateAwaitingPerson(candidate)
          ? 'need'
          : candidate.reasons.isThinking
            ? 'work'
            : entry.session.active
              ? 'idle'
              : null;
      if (!state) return;
      const machineId = resolveDisplayMachineIdForSessionFromState({
        state: params.state,
        serverId: entry.address.serverId,
        sessionId: entry.address.sessionId,
        metadata: readSessionOwnerMetadataView(entry.session),
      });
      if (!machineId) return;
      const states = byMachine.get(machineId);
      if (states) states.push(state);
      else byMachine.set(machineId, [state]);
    },
  );
  return byMachine;
}

const NO_SESSIONS: readonly YourHomeSessionState[] = Object.freeze([]);

/** The active Home's machines and their sessions, on the Activity summary's boundary clock. */
export function useYourHomeModel(): YourHomeModel {
  const { source, nowMs } = useMountedActivityOverviewSummary();
  const serverId = useActiveServerSnapshot().serverId;
  const allMachines = useAllMachines();
  const activeScope = useActiveServerAccountScope();
  const accountScope = selectActiveServerAccountScopeForServer(activeScope, serverId);
  const reachabilityRevision = useMachineReachabilityRevision();
  const presenceNowMs = useMachinePresenceNowMs(allMachines);
  // A replaced identity (the same computer before a reinstall) is not a machine to show or count.
  const machines = React.useMemo(
    () => allMachines.filter((machine) => !isMachineReplaced(machine)),
    [allMachines],
  );
  const names = React.useMemo(
    () => resolveMachineDisplayNames(machines),
    [machines],
  );
  const thisComputerId = useThisComputerMachineId();
  return React.useMemo(() => {
    const sessions = buildYourHomeSessionStates({
      source,
      nowMs,
      serverId,
      state: storage.getState() as SessionMachineTargetState,
    });
    return buildYourHomeModel(
      machines.map((machine) => {
        const reachability = resolveMachineReachability(accountScope, machine, presenceNowMs);
        const online = reachability === 'unknown' ? null : reachability === 'reachable';
        return {
          id: machine.id,
          name: names.get(machine.id) ?? machine.id,
          online,
          lastSeenAt: online === false ? (machine.activeAt ?? null) : null,
          isThisComputer: machine.id === thisComputerId,
          sessions: sessions.get(machine.id) ?? NO_SESSIONS,
        };
      }),
    );
  }, [machines, names, nowMs, serverId, source, thisComputerId, accountScope, presenceNowMs, reachabilityRevision]);
}
