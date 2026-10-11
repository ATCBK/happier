# MFIX16B — client request failure outranks heartbeat

## Outcome

Implemented at the canonical owner, `apps/ui/sources/sync/domains/machines/reachability/machineReachability.ts`. A heartbeat still proves that the daemon is alive on its server socket, but it no longer clears this client's failed-request observation. The same machine remains unreachable for this client until a later request to it succeeds.

No component, copy, layout, token, or style changed. The visual effect is entirely state-driven: after a request failure, the existing machine detail header and rail stop presenting the machine as Online or calm, and the managed Create-one flow stops choosing it as a reachable default. A later successful request restores the existing reachable presentation.

## RED → GREEN evidence

- RED: `machineReachability.test.ts` failed at the newer-heartbeat assertion (`expected true to be false`) after the owner test was changed first.
- GREEN: the same owner test passed, 2/2.
- Adjacent GREEN: `useMachinePresenceSummary.test.tsx` 2/2, `machineCollectionModel.test.ts` 23/23, `workspaceReachability.test.ts` 2/2, and `serverScopedMachineRpc.test.ts` 41/41.
- The adjacent presence-summary test contained the predecessor rule that a later heartbeat restores reachability. It was updated to keep the machine unreachable after the heartbeat; its existing successful-request step still proves recovery.

All focused tests ran through `./apps/stack/bin/hstack-exec -- ...` with automatic placement.

## Import closure and held MFIX16 paths

The remaining uncommitted MFIX16 consumer batch was not committed because it is not import-closed at `HEAD`. In particular, `useMachinePresenceSummary.ts` and `useMachineDaemonReadTarget.ts` import the untracked `apps/ui/sources/sync/domains/machines/resolveServerScopedMachine.ts`, while `HEAD` still owns the old `sync/store/domains/machines/resolveServerScopedMachine.ts` path. Several Machine Resources consumers are themselves untracked and mixed with that program's work.

Held paths:

- `apps/ui/sources/components/machines/agents/AgentSignInTerminal.tsx`
- `apps/ui/sources/components/machines/agents/useFirstAgentSetupItem.tsx`
- `apps/ui/sources/components/machines/attention/collectMachineAttention.ts`
- `apps/ui/sources/components/machines/index/AllMachinesIndex.tsx`
- `apps/ui/sources/components/machines/page/MachinePageHeader.tsx`
- `apps/ui/sources/components/machines/widgets/MachineFleetWidget.tsx`
- `apps/ui/sources/components/navigation/shell/sidebarFooter/SidebarMachinesPopoverContent.tsx`
- `apps/ui/sources/components/sessions/model/useMachinePresenceSummary.test.tsx`
- `apps/ui/sources/components/sessions/model/useMachinePresenceSummary.ts`
- `apps/ui/sources/components/sessions/new/components/MachineSelector.tsx`
- `apps/ui/sources/components/sessions/new/components/NewSessionMachineSelectionContent.tsx`
- `apps/ui/sources/components/sessions/new/components/NewSessionWizard.tsx`
- `apps/ui/sources/components/sessions/new/components/machineSelection/MachineSelectionRowAccessory.tsx`
- `apps/ui/sources/components/sessions/new/components/machineSelection/useMachineSelectionListModel.tsx`
- `apps/ui/sources/components/sessions/new/hooks/machines/useMachineDestinationWorkerStatus.ts`
- `apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionAgentInputPresentation.tsx`
- `apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionAvailabilityState.tsx`
- `apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionMachinePathState.ts`
- `apps/ui/sources/components/sessions/new/hooks/screenModel/useNewSessionMachineRefreshState.ts`
- `apps/ui/sources/components/sessions/shell/SessionView.tsx`
- `apps/ui/sources/components/sessions/work/SessionWorkView.tsx`
- `apps/ui/sources/components/sessions/work/workProjection.test.ts`
- `apps/ui/sources/components/sessions/work/workProjection.ts`
- `apps/ui/sources/components/settings/machines/collection/MachineCollectionList.tsx`
- `apps/ui/sources/components/settings/machines/collection/machineCollectionModel.test.ts`
- `apps/ui/sources/components/settings/machines/machinesSettingsViewModel.ts`
- `apps/ui/sources/components/settings/machines/managed/MachinePresetView.tsx`
- `apps/ui/sources/components/workflows/run/WorkflowRunContent.tsx`
- `apps/ui/sources/components/workflows/run/workflowRunDetailPresentation.test.ts`
- `apps/ui/sources/components/workflows/run/workflowRunDetailPresentation.ts`
- `apps/ui/sources/components/workflows/triggers/ScheduledWork.presentation.test.tsx`
- `apps/ui/sources/sync/domains/machines/identity/resolveMachinePickerPresence.ts`
- `apps/ui/sources/sync/domains/machines/identity/resolveMachineSpawnReadiness.test.ts`
- `apps/ui/sources/sync/domains/machines/identity/resolveMachineSpawnReadiness.ts`
- `apps/ui/sources/sync/domains/machines/resources/useMachineResourceFleetAttention.ts`
- `apps/ui/sources/sync/domains/machines/useMachineDaemonReadTarget.ts`
- `apps/ui/sources/sync/domains/session/input/submitSessionUserMessage.test.ts`
- `apps/ui/sources/sync/domains/session/input/submitSessionUserMessage.ts`
- `apps/ui/sources/sync/domains/workspaces/workspaceReachability.ts`
- `apps/ui/sources/sync/store/hooks.ts`
- `apps/ui/sources/sync/store/hooks.useMachinePresenceCounts.test.tsx`
- `apps/ui/sources/sync/syncEngine.ts`
- `apps/ui/sources/utils/sessions/machinePresenceLine.ts`

## Validation gap and residual risk

The UI package typecheck ran and failed in the heavily shared worktree with broad pre-existing project-list and type errors, beginning in unrelated activity-overlay sources and continuing across CLI, UI, plugin-ui, and voice work. No reported error pointed at the two committed reachability-owner paths. A current-source live replay was not run because the available 18:32 evidence is a frozen pre-fix export; therefore the source correction is focused-test verified, while the exact 33fc/7b41/4633 visual replay remains owed after a current UI rebuild.

The adversarial check re-ran the neighboring successful-request recovery, offline baseline, consumer projection, workspace decision, and RPC producer suites. No second scoped reachability decision was added; all affected readers continue to consume the existing canonical owner.

STATUS: DONE
