import * as React from 'react';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { FrontDoorRuntimeActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { useProjectServiceManagedMachine } from './useProjectServiceManagedMachine';
import type { ProjectServiceSource } from './ProjectServicePlacementControls';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useActionOperationStopControl } from '@/components/inbox/actionOperations/useActionOperationStopControl';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

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
  entries: ReadonlyMap<string, Entry>;
  attach: (serviceName: string, attachment: ProjectServicePlacementOperationAttachment) => void;
  clear: (serviceName: string) => void;
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
  return null;
}

function ScopedObservationProvider(props: Readonly<{
  source: ProjectServiceSource;
  binding: ServerCredentialAccountScopeBinding | null;
  runtimeActionExecute?: FrontDoorRuntimeActionExecute;
  children: React.ReactNode;
}>) {
  const [entries, setEntries] = React.useState<ReadonlyMap<string, Entry>>(() => new Map());
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
  const clear = React.useCallback((serviceName: string) => setEntries(current => {
    if (!current.has(serviceName)) return current;
    const next = new Map(current);
    next.delete(serviceName);
    return next;
  }), []);
  const publish = React.useCallback((serviceName: string, operationId: string, observation: OperationObservation) => setEntries(current => {
    const entry = current.get(serviceName);
    if (!entry || entry.attachment.operationId !== operationId || entry.observation === observation) return current;
    return new Map(current).set(serviceName, { ...entry, observation });
  }), []);
  const context = React.useMemo(() => ({ entries, attach, clear, resolveStart, managedSelections, managedContinuations, selectManaged, observeManaged,
    runtimeActionExecute: props.runtimeActionExecute }),
    [attach, clear, entries, resolveStart, managedSelections, managedContinuations, selectManaged, observeManaged, props.runtimeActionExecute]);
  return <StartContext.Provider value={resolveStart}><Context.Provider value={context}>
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

export function useProjectServicePlacementObservation(serviceName: string, managedScopeKey?: string) {
  const context = React.useContext(Context);
  const attach = React.useCallback((attachment: ProjectServicePlacementOperationAttachment) => context?.attach(serviceName, attachment),
    [context?.attach, serviceName]);
  const clear = React.useCallback(() => context?.clear(serviceName), [context?.clear, serviceName]);
  const entry = context?.entries.get(serviceName);
  React.useLayoutEffect(() => managedScopeKey ? context?.observeManaged(serviceName, managedScopeKey) : undefined,
    [context?.observeManaged, managedScopeKey, serviceName]);
  const managed = context?.managedSelections.get(serviceName)?.scopeKey === managedScopeKey ? context?.managedContinuations.get(serviceName) : undefined;
  const selectManaged = React.useCallback((draft: ManagedMachineSelectionDraft | null, purpose: 'start' | 'move' = 'start') => {
    if (managedScopeKey) context?.selectManaged(serviceName, managedScopeKey, draft, purpose);
  }, [context?.selectManaged, managedScopeKey, serviceName]);
  return { hasOwner: context !== null, attachment: entry?.attachment ?? null,
    operation: entry?.observation?.operation ?? null, stop: entry?.observation?.stop ?? null, attach, clear,
    managed, selectManaged, runtimeActionExecute: context?.runtimeActionExecute };
}

/** The ordinary Service Start button consumes an ephemeral selection before its existing native request. */
export function useProjectServiceStartDestination() {
  return React.useContext(StartContext);
}
