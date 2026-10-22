import { storage } from '@/sync/domains/state/storage';
import { shallow } from 'zustand/vanilla/shallow';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { resolveMachineForActiveServerFromState, resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { resolveVoiceExecutionMachineIdFromState, resolveVoiceExecutionMachineSelectionFromState, type VoiceExecutionMachineSelection } from '@/voice/settings/executionMachine';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useMachinePresenceMembership } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

export type VoiceExecutionMachinePresentation = Readonly<{
  selectedMachineId: string | null;
  machineId: string | null;
  machineLabel: string | null;
  selectionKind: VoiceExecutionMachineSelection['kind'];
}>;

function machineLabelFromState(state: ReturnType<typeof storage.getState>, selectedMachineId: string | null): string | null {
  if (!selectedMachineId) return null;
  const scope = { serverId: getAppliedActiveServerSnapshot().serverId };
  const machines = resolveVisibleMachinesForActiveServerFromState(state, scope).filter(isMachineVisibleForLaunchSelection);
  return getMachineDisplayName(resolveMachineForActiveServerFromState(state, selectedMachineId, scope), machines)
    ?? getMachineDisplayName({ id: selectedMachineId, absence: 'unlisted' });
}

/** The same machine facts used by mounted controls and prepared settings mutations. */
export function resolveVoiceExecutionMachinePresentationFromState(state: ReturnType<typeof storage.getState>): VoiceExecutionMachinePresentation {
  const selection = resolveVoiceExecutionMachineSelectionFromState(state);
  const selectedMachineId = selection.kind === 'none' ? null : selection.machineId;
  return {
    selectedMachineId,
    machineId: selection.kind === 'resolved' ? selectedMachineId : null,
    machineLabel: machineLabelFromState(state, selectedMachineId),
    selectionKind: selection.kind,
  };
}

/**
 * The single UI projection of the selected voice execution machine.
 * Credential settings use this for both display and request invalidation.
 */
function useVoiceExecutionMachineState<Value>(select: (state: ReturnType<typeof storage.getState>) => Value): Value {
  const scope = useAccountSettingsScope();
  useMachinePresenceMembership(scope?.serverId ?? null);
  useVoiceTargetStore((state) => scope
    ? state.autoTargetMachineByScope[accountSettingsScopeKeySuffix(scope)]
    : undefined);
  // Cache selection by the stable storage snapshot: presence can expire
  // between React's reads without the storage object changing.
  // A fresh selector on render also observes local auto-target and scope wakes.
  return useStoreWithEqualityFn(storage, state => select(state), shallow);
}

/** Execution consumers subscribe to selection, without machine label presentation. */
export function useVoiceExecutionMachineId(): string | null {
  return useVoiceExecutionMachineState(resolveVoiceExecutionMachineIdFromState);
}

export function useVoiceExecutionMachinePresentation(): VoiceExecutionMachinePresentation {
  const selection = useVoiceExecutionMachineState(resolveVoiceExecutionMachineSelectionFromState);
  const selectionKind = selection.kind;
  const selectedMachineId = selection.kind === 'none' ? null : selection.machineId;
  const machineId = selection.kind === 'resolved' ? selectedMachineId : null;
  const machineLabel = useStoreWithEqualityFn(storage, state => machineLabelFromState(state, selectedMachineId));
  return { selectedMachineId, machineId, machineLabel, selectionKind };
}
