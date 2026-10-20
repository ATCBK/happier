import * as React from 'react';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { FrontDoorRuntimeActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { useProjectServiceManagedMachine } from './useProjectServiceManagedMachine';
import type { ProjectServiceSource } from './ProjectServicePlacementControls';
import { useActionOperation, useProjectServiceActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useActionOperationStopControl } from '@/components/inbox/actionOperations/useActionOperationStopControl';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ServiceRelocationOutcome } from './serviceRelocationAction';
import { publishActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationRuntime';
import { invalidateLocalServiceLauncherStores } from '@/sync/domains/local/services/launch/sharedStore';

export type ProjectServicePlacementOperationAttachment = Readonly<{
  operationId: string;
  destination: ProjectExecutionChoiceV1;
}>;

type OperationObservation = Readonly<{
  operation: ReturnType<typeof useActionOperation>;
  stop: Pick<ReturnType<typeof useActionOperationStopControl>, 'pending' | 'stopRequested' | 'requestStop'>;
}>;
type Entry = Readonly<{ attachment: ProjectServicePlacementOperationAttachment; observation?: OperationObservation }>;
type ManagedSelection = Readonly<{ scopeKey: string; draft: ManagedMachineSelectionDraft; purpose: 'start' | 'move' }>;
type ManagedContinuation = ReturnType<typeof useProjectServiceManagedMachine>;
type ObservationContext = Readonly<{
  source: ProjectServiceSource;
  entries: ReadonlyMap<string, Entry>;
  attach: (serviceName: string, attachment: ProjectServicePlacementOperationAttachment) => void;
  clear: (serviceName: string) => void;
  pendingRequests: ReadonlySet<string>;
  executeMove: (serviceName: string, destination: ProjectExecutionChoiceV1,
    execute: (signal: AbortSignal, onApprovalPending: (registration: ActionApprovalRegistration) => void) => Promise<ServiceRelocationOutcome>) => Promise<ServiceRelocationOutcome | null>;
  runtimeActionExecute?: FrontDoorRuntimeActionExecute;
  managedSelections: ReadonlyMap<string, ManagedSelection>;
  managedContinuations: ReadonlyMap<string, ManagedContinuation>;
  selectManaged: (name: string, scopeKey: string, draft: ManagedMachineSelectionDraft | null, purpose: 'start' | 'move') => void;
  observeManaged: (name: string, scopeKey: string) => () => void;
  resolveStart: (target: LocalServiceLaunchTarget, signal?: AbortSignal) => Promise<ProjectExecutionChoiceV1 | null> | undefined;
}>;
const Context = React.createContext<ObservationContext | null>(null);
const StartContext = React.createContext<ObservationContext['resolveStart'] | undefined>(undefined);

/** List and pushed detail can coexist; one owner retains their service's single purchase/start intent. */
function ServiceManagedMachineObserver(props: Readonly<{
  source: ProjectServiceSource;
  binding: ServerCredentialAccountScopeBinding | null;
  runtimeActionExecute?: FrontDoorRuntimeActionExecute;
  name: string;
  selection: ManagedSelection;
  publish: (name: string, value: ManagedContinuation) => void;
}>) {
  const managed = useProjectServiceManagedMachine({ scopeKey: props.selection.scopeKey,
    serverId: props.source.serverId, binding: props.binding, runtimeActionExecute: props.runtimeActionExecute });
  React.useLayoutEffect(() => managed.select(props.selection.draft), [managed.select, props.selection.draft]);
  React.useLayoutEffect(() => props.publish(props.name, managed), [props.name, props.publish, managed]);
  return null;
}

/** One canonical operation/Cancel observer for each accepted service, shared by both row bodies. */
function ServiceOperationObserver(props: Readonly<{
  source: ProjectServiceSource;
  accountId: string;
  serviceName: string;
  attachment: ProjectServicePlacementOperationAttachment;
  publish: (serviceName: string, operationId: string, observation: OperationObservation) => void;
}>) {
  const record = useActionOperation({ serverId: props.source.serverId, operationId: props.attachment.operationId });
  const operation = record?.snapshot.scope.accountId === props.accountId
    && record.snapshot.actionId === 'projects.service.relocate' ? record : null;
  const active = operation?.snapshot.state === 'accepted' || operation?.snapshot.state === 'running';
  const stop = useActionOperationStopControl(active ? operation : null);
  const observation = React.useMemo(() => ({ operation,
    stop: { pending: stop.pending, stopRequested: stop.stopRequested, requestStop: stop.requestStop } }),
  [operation, stop.pending, stop.stopRequested, stop.requestStop]);
  React.useEffect(() => {
    props.publish(props.serviceName, props.attachment.operationId, observation);
  }, [observation, props.attachment.operationId, props.publish, props.serviceName]);
  const state = operation?.snapshot.state;
  React.useEffect(() => {
    if (state !== 'succeeded' && state !== 'failed' && state !== 'cancelled') return;
    // Settlement is independent of inventory scan generations. Re-read native facts,
    // including absence, rather than leaving a cached Running row until page reload.
    const machines = new Set([props.source.machineId, operation!.snapshot.scope.machineId]);
    const destination = props.attachment.destination;
    if (destination.kind === 'workers' && destination.destination.kind === 'machine') machines.add(destination.destination.machineId);
    for (const machineId of machines) invalidateLocalServiceLauncherStores({ serverId: props.source.serverId, machineId });
  }, [state, props.attachment, props.source.machineId, props.source.serverId]);
  return null;
}

/** Independent Service requests keep independent Artifact readers, even while another Ask is open. */
function ServiceMoveApprovalObserver(props: Readonly<{
  source: ProjectServiceSource;
  serviceName: string;
  registration: ActionApprovalRegistration;
}>) {
  const approval = useActionApprovalContinuation({
    scopeKey: JSON.stringify(['projects.service.relocate', props.source.serverId, props.source.refId, props.serviceName]),
    serverId: props.source.serverId,
    onExecuted: () => {},
  });
  React.useEffect(() => approval.requestApproval(props.registration), [approval.requestApproval, props.registration]);
  return null;
}

function ScopedObservationProvider(props: Readonly<{
  source: ProjectServiceSource;
  binding: ServerCredentialAccountScopeBinding | null;
  runtimeActionExecute?: FrontDoorRuntimeActionExecute;
  children: React.ReactNode;
}>) {
  const [entries, setEntries] = React.useState<ReadonlyMap<string, Entry>>(() => new Map());
  const cleared = React.useRef(new Set<string>());
  const received = useProjectServiceActionOperations({ ...props.source, accountId: props.binding?.accountId ?? null });
  React.useEffect(() => {
    setEntries(current => {
      let next: Map<string, Entry> | null = null;
      for (const operation of received) {
        const { snapshot } = operation;
        const domain = snapshot.domainRef;
        if (domain?.kind !== 'projectService' || domain.declaration.selection.kind !== 'manifest'
          || snapshot.state === 'succeeded' || cleared.current.has(snapshot.operationId)) continue;
        const name = domain.declaration.selection.name;
        const previous = current.get(name);
        if (previous?.attachment.operationId === snapshot.operationId) continue;
        const retained = previous && actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), {
          serverId: props.source.serverId, operationId: previous.attachment.operationId,
        });
        if (retained && (retained.snapshot.state === 'accepted' || retained.snapshot.state === 'running')
          && retained.snapshot.createdAt >= snapshot.createdAt) continue;
        const destination = domain.destinationWorkspace ?? domain.workspace;
        next ??= new Map(current);
        next.set(name, { attachment: { operationId: snapshot.operationId,
          destination: destination.machineId === props.source.machineId ? { kind: 'primary' }
            : { kind: 'workers', destination: { kind: 'machine', machineId: destination.machineId } } } });
      }
      return next ?? current;
    });
  }, [received, props.source.machineId, props.source.serverId]);
  const requests = React.useRef(new Map<string, AbortController>());
  const [pendingRequests, setPendingRequests] = React.useState<ReadonlySet<string>>(() => new Set());
  const [approvals, setApprovals] = React.useState<ReadonlyMap<string, ActionApprovalRegistration>>(() => new Map());
  React.useEffect(() => {
    const abort = () => { for (const request of requests.current.values()) request.abort(); requests.current.clear(); };
    const retirement = props.binding?.onRetire(abort);
    return () => { retirement?.dispose(); abort(); };
  }, [props.binding]);
  const [managedSelections, setManagedSelections] = React.useState<ReadonlyMap<string, ManagedSelection>>(() => new Map());
  const [managedContinuations, setManagedContinuations] = React.useState<ReadonlyMap<string, ManagedContinuation>>(() => new Map());
  const consumers = React.useRef(new Map<string, number>());
  const removeManaged = React.useCallback((name: string) => {
    setManagedSelections(current => { if (!current.has(name)) return current; const next = new Map(current); next.delete(name); return next; });
    setManagedContinuations(current => { if (!current.has(name)) return current; const next = new Map(current); next.delete(name); return next; });
  }, []);
  const observeManaged = React.useCallback((name: string, scopeKey: string) => {
    consumers.current.set(name, (consumers.current.get(name) ?? 0) + 1);
    setManagedSelections(current => {
      if (!current.has(name) || current.get(name)?.scopeKey === scopeKey) return current;
      const next = new Map(current); next.delete(name); return next;
    });
    return () => {
      const count = (consumers.current.get(name) ?? 1) - 1;
      if (count) consumers.current.set(name, count);
      else { consumers.current.delete(name); removeManaged(name); }
    };
  }, [removeManaged]);
  const selectManaged = React.useCallback((name: string, scopeKey: string, draft: ManagedMachineSelectionDraft | null, purpose: 'start' | 'move') => {
    if (!draft) { removeManaged(name); return; }
    setManagedSelections(current => new Map(current).set(name, { scopeKey, draft, purpose }));
  }, [removeManaged]);
  const publishManaged = React.useCallback((name: string, value: ManagedContinuation) => setManagedContinuations(current =>
    current.get(name) === value ? current : new Map(current).set(name, value)), []);
  const selectedRef = React.useRef(managedSelections);
  selectedRef.current = managedSelections;
  const managedRef = React.useRef(managedContinuations);
  managedRef.current = managedContinuations;
  const resolveStart = React.useCallback((target: LocalServiceLaunchTarget, signal?: AbortSignal) => {
    const declaration = target.declaration;
    if (!target.workspace || !declaration || declaration.selection.kind !== 'manifest'
      || declaration.workspaceRefId !== props.source.refId || target.workspace.machineId !== props.source.machineId
      || !areServerProfileIdentifiersEquivalent(target.workspace.serverId, props.source.serverId)) return undefined;
    const name = declaration.selection.name;
    const selected = selectedRef.current.get(name);
    return selected ? selected.purpose === 'start' ? managedRef.current.get(name)?.acquire(signal) ?? Promise.resolve(null)
      : Promise.resolve(null) : undefined;
  }, [props.source.machineId, props.source.refId, props.source.serverId]);
  React.useEffect(() => {
    const retirement = props.binding?.onRetire(() => setEntries(new Map()));
    return () => retirement?.dispose();
  }, [props.binding]);
  const attach = React.useCallback((serviceName: string, attachment: ProjectServicePlacementOperationAttachment) => {
    if (!props.binding?.isCurrent()) return;
    const operation = actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), {
      serverId: props.source.serverId, operationId: attachment.operationId,
    });
    if (!operation || operation.snapshot.scope.accountId !== props.binding.accountId
      || operation.snapshot.actionId !== 'projects.service.relocate') return;
    // Exact request/Account admission is proven by executeServiceRelocationAction.
    // The domain reference is the actual old/new workspace, never a guessed Source ref.
    setEntries(current => new Map(current).set(serviceName, { attachment }));
  }, [props.binding, props.source.serverId]);
  const executeMove = React.useCallback<ObservationContext['executeMove']>(async (serviceName, destination, execute) => {
    if (!props.binding?.isCurrent() || requests.current.has(serviceName)) return null;
    const request = new AbortController();
    requests.current.set(serviceName, request);
    setPendingRequests(new Set(requests.current.keys()));
    try {
      const result = await execute(request.signal, registration => {
        if (!request.signal.aborted) setApprovals(current => new Map(current).set(serviceName, registration));
      });
      if (request.signal.aborted || !props.binding.isCurrent()) return null;
      if (result.status === 'accepted') {
        publishActionOperationObservation({ serverId: props.source.serverId, machineId: result.operation.scope.machineId,
          observation: 'available', snapshots: [result.operation] });
        attach(serviceName, { destination, operationId: result.operation.operationId });
      }
      return result;
    } finally {
      if (requests.current.get(serviceName) === request) {
        requests.current.delete(serviceName);
        setPendingRequests(new Set(requests.current.keys()));
        setApprovals(current => { const next = new Map(current); next.delete(serviceName); return next; });
      }
    }
  }, [attach, props.binding, props.source.serverId]);
  const clear = React.useCallback((serviceName: string) => setEntries(current => {
    if (!current.has(serviceName)) return current;
    cleared.current.add(current.get(serviceName)!.attachment.operationId);
    const next = new Map(current);
    next.delete(serviceName);
    return next;
  }), []);
  const publish = React.useCallback((serviceName: string, operationId: string, observation: OperationObservation) => setEntries(current => {
    const entry = current.get(serviceName);
    if (!entry || entry.attachment.operationId !== operationId || entry.observation === observation) return current;
    return new Map(current).set(serviceName, { ...entry, observation });
  }), []);
  const source = React.useMemo(() => props.source, [props.source.serverId, props.source.refId, props.source.machineId]);
  const context = React.useMemo(() => ({ source, entries, attach, clear, executeMove, pendingRequests, resolveStart, managedSelections, managedContinuations, selectManaged, observeManaged,
    runtimeActionExecute: props.runtimeActionExecute }),
    [source, attach, clear, executeMove, pendingRequests, entries, resolveStart, managedSelections, managedContinuations, selectManaged, observeManaged, props.runtimeActionExecute]);
  return <StartContext.Provider value={resolveStart}><Context.Provider value={context}>
    {[...approvals].map(([serviceName, registration]) => <ServiceMoveApprovalObserver key={serviceName}
      source={props.source} serviceName={serviceName} registration={registration} />)}
    {[...managedSelections].map(([name, selection]) => <ServiceManagedMachineObserver key={name} source={props.source}
      binding={props.binding} runtimeActionExecute={props.runtimeActionExecute} name={name} selection={selection} publish={publishManaged} />)}
    {props.binding ? [...entries].map(([serviceName, entry]) => <ServiceOperationObserver
      key={`${serviceName}:${entry.attachment.operationId}`} source={props.source} accountId={props.binding!.accountId}
      serviceName={serviceName} attachment={entry.attachment} publish={publish} />) : null}
    {props.children}
  </Context.Provider></StartContext.Provider>;
}

/** The retained Services host owns attachment lifetime; phone Back only replaces its presentation. */
export function ProjectServicePlacementObservationProvider(props: Readonly<{
  source: ProjectServiceSource;
  runtimeActionExecute?: FrontDoorRuntimeActionExecute;
  children: React.ReactNode;
}>) {
  const { binding } = useServerCredentialAccountScopeBinding(props.source.serverId);
  const scopeKey = JSON.stringify([props.source.serverId, props.source.refId, props.source.machineId,
    binding?.accountId, binding?.revision]);
  return <ScopedObservationProvider key={scopeKey} source={props.source} binding={binding} runtimeActionExecute={props.runtimeActionExecute}>{props.children}</ScopedObservationProvider>;
}

export function useProjectServicePlacementObservation(serviceName: string, managedScopeKey?: string,
  native?: Readonly<{ declarationWorkspaceRefId?: string; absent: boolean }>) {
  const context = React.useContext(Context);
  const attach = React.useCallback((attachment: ProjectServicePlacementOperationAttachment) => context?.attach(serviceName, attachment),
    [context?.attach, serviceName]);
  const clear = React.useCallback(() => context?.clear(serviceName), [context?.clear, serviceName]);
  const executeMove = React.useCallback((destination: ProjectExecutionChoiceV1,
    execute: Parameters<ObservationContext['executeMove']>[2]) => context?.executeMove(serviceName, destination, execute) ?? Promise.resolve(null),
  [context?.executeMove, serviceName]);
  const candidate = context?.entries.get(serviceName);
  const domain = candidate?.observation?.operation?.snapshot.domainRef;
  const declarationWorkspaceRefId = native?.declarationWorkspaceRefId;
  const entry = declarationWorkspaceRefId === undefined || declarationWorkspaceRefId === context?.source.refId
    || (domain?.kind === 'projectService' && domain.declaration?.workspaceRefId === declarationWorkspaceRefId) ? candidate : undefined;
  const destination = entry?.attachment.destination;
  const destinationMachineId = destination?.kind === 'primary' ? context?.source.machineId
    : destination?.destination.kind === 'machine' ? destination.destination.machineId : null;
  const destinationMachine = useServerScopedMachine(context?.source.serverId ?? '', destinationMachineId ?? '');
  const operation = entry?.observation?.operation;
  const snapshot = operation?.snapshot;
  const phase = snapshot?.progress?.kind === 'phase' ? snapshot.progress.phase : null;
  const unknown = operation?.observation !== 'available' || snapshot?.observation?.kind === 'outcome_uncertain'
    || snapshot?.error?.errorCode === 'outcome_uncertain' || snapshot?.state === 'failed' || snapshot?.state === 'cancelled';
  const stoppedBeforeStart = native?.absent === true && operation?.observation === 'available'
    && (snapshot?.state === 'failed' || snapshot?.state === 'cancelled')
    && (phase === 'stopped' || phase === 'copying' || phase === 'preparing'
      || phase === 'starting' && (snapshot.error?.errorCode === 'project_setup_consent_required'
        || snapshot.error?.errorCode === 'project_setup_effect_changed')) && snapshot?.observation?.kind !== 'outcome_uncertain'
    && snapshot?.error?.errorCode !== 'outcome_uncertain';
  const failedBeforeStop = operation?.observation === 'available'
    && (snapshot?.state === 'failed' || snapshot?.state === 'cancelled') && phase === null;
  // Attachments retain inspection/recovery history. Only unresolved relocation
  // overrides native row facts; a succeeded operation's last phase is historical.
  const relocating = entry !== undefined && snapshot?.state !== 'succeeded' && !stoppedBeforeStart && !failedBeforeStop;
  const destinationName = (destinationMachine ? getMachineDisplayName(destinationMachine) : null) ?? t('projectServices.otherMachine');
  const progressText = !relocating ? null : unknown ? t('projectServices.moveUnknown')
    : phase === 'stopping' ? t('localServices.rowStatus.stopping')
    : phase === 'stopped' ? t('localServices.rowStatus.stopped')
    : phase === 'copying' ? t('projectWorkers.copying', { machine: destinationName })
    : phase === 'preparing' ? t('projectWorkers.preparing', { machine: destinationName })
    : phase === 'starting' ? t('localServices.row.startingOn', { machine: destinationName })
    : t('projectServices.moving', { service: serviceName, to: destinationName });
  React.useLayoutEffect(() => managedScopeKey ? context?.observeManaged(serviceName, managedScopeKey) : undefined,
    [context?.observeManaged, managedScopeKey, serviceName]);
  const managed = context?.managedSelections.get(serviceName)?.scopeKey === managedScopeKey ? context?.managedContinuations.get(serviceName) : undefined;
  const selectManaged = React.useCallback((draft: ManagedMachineSelectionDraft | null, purpose: 'start' | 'move' = 'start') => {
    if (managedScopeKey) context?.selectManaged(serviceName, managedScopeKey, draft, purpose);
  }, [context?.selectManaged, managedScopeKey, serviceName]);
  return { hasOwner: context !== null, attachment: entry?.attachment ?? null,
    operation: operation ?? null, relocating, progressText, stoppedBeforeStart, failedBeforeStop, stop: entry?.observation?.stop ?? null, attach, clear,
    executeMove, requestPending: context?.pendingRequests.has(serviceName) ?? false,
    managed, selectManaged, runtimeActionExecute: context?.runtimeActionExecute };
}

/** The ordinary Service Start button consumes an ephemeral selection before its existing native request. */
export function useProjectServiceStartDestination() {
  return React.useContext(StartContext);
}
