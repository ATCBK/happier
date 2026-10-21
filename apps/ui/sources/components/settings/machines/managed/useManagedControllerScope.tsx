import * as React from 'react';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';

import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { isMachineAdministrationCandidateExplicitlySelectable, isMachineAdministrationCandidateSelectable, resolveMachineAdministrationTargetState } from '@/sync/domains/machines/administration/targetSelection';
import {
  useMachineAdministrationTargetPickerRows,
  resolveFreshMachineAdministrationExecutionTarget,
  doesMachineAdministrationTargetMatchActiveAccount,
  type MachineAdministrationTargetSelectionV1,
  type MachineAdministrationExecutionTargetOptions,
} from '@/sync/domains/machines/administration/useTargetSelection';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useMachineListForServer, useActiveServerAccountScope, useSetting } from '@/sync/domains/state/storage';
import { useIsMachineListSettled, useMachineListStatusForServer } from '@/sync/store/hooks';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { storage } from '@/sync/domains/state/storageStore';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1, setMachineAdministrationTargetPreference } from '@/sync/domains/machines/administration/selectionPreferences';
import { readMachineRequestReachabilityObservation } from '@/sync/domains/machines/reachability/machineReachability';

export type ManagedControllerScope = Readonly<{
  /** The machine whose installation runs provider calls: the person's choice, else the preselected default. */
  controller: ManagedControllerV1 | undefined;
  /** The chosen machine's record, for its name and presence. */
  machine: Machine | undefined;
  /** Whether any machine in this Home can manage machines at all. */
  hasCandidates: boolean;
  /**
   * Whether this Home's machine list has been read: an empty `hasCandidates` before that is not
   * "no machine can manage", and `unavailable` is a list that could not be read (retry re-reads it).
   */
  machineList: 'settled' | 'loading' | 'unavailable';
  /** The canonical machine-scope chip, for the page header (or the section that owns the scope). */
  chip: React.ReactElement | null;
  /** The same chosen controller, revalidated by the Administration execution owner. */
  selection?: MachineAdministrationTargetSelectionV1;
}>;

/**
 * "Managed from": which of this Home's machines with an installation runs a provisioner's calls
 * (lab `m-add` / `m-config`). It is shown through the canonical header chip
 * (`MachineAdministrationTargetSelector presentation="chip"`), offering only machines that can manage,
 * and starts on a sensible machine so the first frame is the catalog: this computer when it can
 * manage online, else a deterministic online candidate. The choice is page-local, as the
 * draft it scopes is.
 */
/** Installed controllers, including asleep ones, but never retired identities. */
export function isManagedControllerCandidate(machine: Machine): boolean {
  return !!machine.installationId && !machine.revokedAt && !isMachineReplaced(machine);
}

export function useManagedControllerScope(
  input: Readonly<{
    serverId: string;
    /** A machine the page already names (a preset's controller, the picker's handoff), used until the person picks. */
    preferred?: ManagedControllerV1;
    disabled?: boolean;
    onSelect?: (controller: ManagedControllerV1) => void;
    testIDPrefix: string;
  }>,
): ManagedControllerScope {
  const machines = useMachineListForServer(input.serverId);
  const listSettled = useIsMachineListSettled(input.serverId);
  const listStatus = useMachineListStatusForServer(input.serverId);
  const activeAccountScope = useActiveServerAccountScope();
  const { binding } = useServerCredentialAccountScopeBinding(input.serverId);
  const rows = useMachineAdministrationTargetPickerRows();
  const thisMachineId = useThisComputerMachineId();
  // The person's last explicit pick on this device, so re-entering Add starts where they left off.
  const rememberedTarget = useSetting('machineAdministrationTargetsLocalV1')[MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.managedMachines];
  const settingsScope = useAccountSettingsScope();
  const [chosen, setChosen] = React.useState<Readonly<{
    serverId: string; accountId: string | undefined; controller: ManagedControllerV1; explicit: boolean;
  }>>();
  const accountId = binding?.isCurrent() ? binding.scope.accountId : undefined;
  const scopedChoice = chosen && chosen.accountId === accountId && areServerProfileIdentifiersEquivalent(chosen.serverId, input.serverId)
    ? chosen : undefined;
  const preferredMachineId = input.preferred?.machineId;
  const preferredInstallationId = input.preferred?.installationId;
  const namedRetained = scopedChoice?.explicit ? scopedChoice.controller
    : preferredMachineId && preferredInstallationId ? input.preferred : undefined;
  const { onSelect } = input;

  const eligible = React.useMemo(
    () =>
      (machines ?? []).filter(isManagedControllerCandidate),
    [machines],
  );
  const scopedRows = React.useMemo(
    () =>
      rows.filter(
        (row) =>
          areServerProfileIdentifiersEquivalent(row.serverId, input.serverId) &&
          (row.candidate.target.machineId === namedRetained?.machineId || eligible.some(
            (machine) => machine.id === row.candidate.target.machineId,
          )),
      ),
    [eligible, input.serverId, namedRetained?.machineId, rows],
  );
  const automaticRetainedRow = !namedRetained && scopedChoice && !scopedChoice.explicit
    ? scopedRows.find((row) => row.candidate.target.machineId === scopedChoice.controller.machineId)
    : undefined;
  // An automatic pick is kept across presence churn only while its machine is still selectable; one that went
  // offline (a first frame from warm cache, a stale beat) yields to the next online controller.
  const automaticRetained = automaticRetainedRow && scopedChoice
    && isMachineAdministrationCandidateSelectable(automaticRetainedRow.candidate)
    && readMachineRequestReachabilityObservation(
      binding?.isCurrent() ? binding.scope : null,
      automaticRetainedRow.candidate.target.machineId,
    )?.outcome !== 'failed'
    ? scopedChoice.controller
    : undefined;
  const retained = namedRetained ?? automaticRetained;
  // Kept identity-stable by its ids: presence updates must not restart the reads it scopes.
  const preferred = React.useMemo(() => {
    // A draft keeps its exact installation even when asleep, missing or replaced; fresh execution
    // admission decides whether it can run. Inventory churn must never silently redirect it.
    if (retained) return retained;
    const online = eligible.filter((candidate) =>
        scopedRows.some(
          (row) =>
            row.candidate.target.machineId === candidate.id &&
            isMachineAdministrationCandidateSelectable(row.candidate),
        ),
    ).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const remembered = rememberedTarget ? online.find((candidate) => candidate.id === rememberedTarget.machineId
      && scopedRows.some((row) => row.candidate.target.machineId === candidate.id
        && row.candidate.target.serverIdentityId === rememberedTarget.serverIdentityId)) : undefined;
    // Otherwise a machine whose last request did not fail, so the first frame is a catalog that can be read.
    const readScope = binding?.isCurrent() ? binding.scope : null;
    const readable = online.filter((candidate) => readMachineRequestReachabilityObservation(readScope, candidate.id)?.outcome !== 'failed');
    const machine = remembered ?? (readable.length > 0 ? readable : online).find((candidate) => candidate.id === thisMachineId)
      ?? (readable.length > 0 ? readable : online)[0];
    return machine?.installationId
      ? { machineId: machine.id, installationId: machine.installationId }
      : undefined;
  }, [retained?.machineId, retained?.installationId, eligible, scopedRows, thisMachineId, rememberedTarget?.machineId, rememberedTarget?.serverIdentityId]);
  const controllerMachineId = preferred?.machineId;
  const controllerInstallationId = preferred?.installationId;
  const controller = React.useMemo(
    (): ManagedControllerV1 | undefined =>
      controllerMachineId && controllerInstallationId
        ? { machineId: controllerMachineId, installationId: controllerInstallationId }
        : undefined,
    [controllerMachineId, controllerInstallationId],
  );
  React.useEffect(() => {
    if (!retained && controller) setChosen({ serverId: input.serverId, accountId, controller, explicit: false });
  }, [retained?.machineId, retained?.installationId, controller, input.serverId, accountId]);

  const selection =
    React.useMemo((): MachineAdministrationTargetSelectionV1 => {
      const candidates = scopedRows.map((row) => row.candidate);
      const selectedTarget =
        scopedRows.find(
          (row) => row.candidate.target.machineId === controller?.machineId,
        )?.candidate.target ?? null;
      const matchesAccount = doesMachineAdministrationTargetMatchActiveAccount({ target: selectedTarget, activeAccountServerId: activeAccountScope?.serverId });
      const resolveExecutionTarget = (options?: MachineAdministrationExecutionTargetOptions) => {
        if (!matchesAccount || !selectedTarget || !controller || !binding?.isCurrent()) return null;
        const current = resolveFreshMachineAdministrationExecutionTarget(selectedTarget, { ...options, accountScope: binding.scope });
        return current?.machine.installationId === controller.installationId ? current : null;
      };
      return {
        candidates,
        pickerRows: scopedRows,
        state: resolveMachineAdministrationTargetState({
          storedTarget: selectedTarget,
          candidates,
          allowSoleCandidate: false,
        }),
        selectedTarget,
        selectedTargetServerMatchesActiveAccount: matchesAccount,
        canExecute: resolveExecutionTarget() !== null,
        changeIntent: onSelect ? 'draft' : 'scope',
        selectTarget: (target) => {
          if (!scopedRows.some(row => row.candidate.target.machineId === target.machineId
            && row.candidate.target.serverIdentityId === target.serverIdentityId
            && isMachineAdministrationCandidateExplicitlySelectable(row.candidate, 'lastKnown'))) return;
          const machine = eligible.find(
            (candidate) => candidate.id === target.machineId,
          );
          if (!machine?.installationId) return;
          const next = {
            machineId: machine.id,
            installationId: machine.installationId,
          };
          setChosen({ serverId: input.serverId, accountId, controller: next, explicit: true });
          const current = storage.getState();
          if (settingsScope && areAccountSettingsScopesEqual(settingsScope, current.settingsScope)) {
            getSyncSingleton().applySettings({ machineAdministrationTargetsLocalV1: setMachineAdministrationTargetPreference(
              current.settings.machineAdministrationTargetsLocalV1, MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.managedMachines, target) },
              { expectedSettingsScope: settingsScope, source: 'ui' });
          }
          onSelect?.(next);
        },
        clearTarget: () => {},
        resolveExecutionTarget,
      };
    }, [binding, controller?.machineId, controller?.installationId, eligible, onSelect, scopedRows, activeAccountScope?.serverId, input.serverId, accountId, settingsScope]);

  const chip =
    scopedRows.length > 0 ? (
      <MachineAdministrationTargetSelector
        presentation="chip"
        selection={selection}
        groupTitle={t('managedMachines.config.managedFrom')}
        selectionPolicy="lastKnown"
        disabled={input.disabled}
        testIDPrefix={input.testIDPrefix}
      />
    ) : null;
  return {
    controller,
    machine: machines?.find((machine) => machine.id === controller?.machineId),
    hasCandidates: eligible.length > 0,
    machineList: listSettled ? 'settled' : listStatus === 'error' || listStatus === 'signedOut' ? 'unavailable' : 'loading',
    chip,
    selection,
  };
}
