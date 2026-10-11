import * as React from 'react';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';

import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { isMachineAdministrationCandidateSelectable, resolveMachineAdministrationTargetState } from '@/sync/domains/machines/administration/targetSelection';
import {
  useMachineAdministrationTargetPickerRows,
  resolveFreshMachineAdministrationExecutionTarget,
  doesMachineAdministrationTargetMatchActiveAccount,
  type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useMachineListForServer, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

export type ManagedControllerScope = Readonly<{
  /** The machine whose installation runs provider calls: the person's choice, else the preselected default. */
  controller: ManagedControllerV1 | undefined;
  /** The chosen machine's record, for its name and presence. */
  machine: Machine | undefined;
  /** Whether any machine in this Home can manage machines at all. */
  hasCandidates: boolean;
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
  const activeAccountScope = useActiveServerAccountScope();
  const rows = useMachineAdministrationTargetPickerRows();
  const thisMachineId = useThisComputerMachineId();
  const [chosen, setChosen] = React.useState<Readonly<{
    serverId: string; accountId: string | undefined; controller: ManagedControllerV1; explicit: boolean;
  }>>();
  const accountId = activeAccountScope?.accountId;
  const scopedChoice = chosen && chosen.accountId === accountId && areServerProfileIdentifiersEquivalent(chosen.serverId, input.serverId)
    ? chosen : undefined;
  const preferredMachineId = input.preferred?.machineId;
  const preferredInstallationId = input.preferred?.installationId;
  const retained = scopedChoice?.explicit ? scopedChoice.controller
    : preferredMachineId && preferredInstallationId ? input.preferred : scopedChoice?.controller;
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
          (row.candidate.target.machineId === retained?.machineId || eligible.some(
            (machine) => machine.id === row.candidate.target.machineId,
          )),
      ),
    [eligible, input.serverId, rows, retained?.machineId],
  );
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
    const machine = online.find((candidate) => candidate.id === thisMachineId) ?? online[0];
    return machine?.installationId
      ? { machineId: machine.id, installationId: machine.installationId }
      : undefined;
  }, [retained?.machineId, retained?.installationId, eligible, scopedRows, thisMachineId]);
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
      const resolveExecutionTarget = () => {
        if (!matchesAccount || !selectedTarget || !controller) return null;
        const current = resolveFreshMachineAdministrationExecutionTarget(selectedTarget);
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
        selectTarget: (target) => {
          if (!scopedRows.some(row => row.candidate.target.machineId === target.machineId
            && row.candidate.target.serverIdentityId === target.serverIdentityId
            && isMachineAdministrationCandidateSelectable(row.candidate))) return;
          const machine = eligible.find(
            (candidate) => candidate.id === target.machineId,
          );
          if (!machine?.installationId) return;
          const next = {
            machineId: machine.id,
            installationId: machine.installationId,
          };
          setChosen({ serverId: input.serverId, accountId, controller: next, explicit: true });
          onSelect?.(next);
        },
        clearTarget: () => {},
        resolveExecutionTarget,
      };
    }, [controller?.machineId, controller?.installationId, eligible, onSelect, scopedRows, activeAccountScope?.serverId, input.serverId, accountId]);

  const chip =
    scopedRows.length > 0 ? (
      <MachineAdministrationTargetSelector
        presentation="chip"
        selection={selection}
        groupTitle={t('managedMachines.config.managedFrom')}
        disabled={input.disabled}
        testIDPrefix={input.testIDPrefix}
      />
    ) : null;
  return {
    controller,
    machine: machines?.find((machine) => machine.id === controller?.machineId),
    hasCandidates: eligible.length > 0,
    chip,
    selection,
  };
}
