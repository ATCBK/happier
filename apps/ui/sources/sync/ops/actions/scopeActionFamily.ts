import { normalizeSessionListFilterHomeIds } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { ScopeActionInputSchemas, type ScopeActionId, type ScopeActionInputById, type ScopeActionOutputById, type ShellColumn, type FileViewMode } from '@happier-dev/protocol/actions/scopeActionFamily';
import type { FileChangesScope } from '@happier-dev/protocol/scm';
import type { SessionListViewFilterController } from '@/components/sessions/shell/search/useSessionListViewFilterController';
import { resolveSessionListViewContextDefaults } from '@/components/sessions/shell/search/sessionListViewFilters';
import { resolveSessionListFilterScopeAvailability } from '@/components/sessions/shell/search/sessionListFilterEditorModel';
import type { WorkflowLibraryViewController } from '@/components/workflows/library/useWorkflowLibraryView';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';

export type SessionListScopeActionController = Pick<SessionListViewFilterController,
  'filters' | 'updateFilters' | 'resetFilters' | 'viewContext' | 'viewContextKey' | 'corpusStorage'
  | 'retentionScopeKey'
  | 'includeInactive' | 'setIncludeInactive' | 'setSource' | 'queryEnabled' | 'followingAvailable'
  | 'sourceAvailable' | 'homeOptions' | 'fixedHomeServerIds'>;

type SessionListActionOwner = Readonly<{
  read: () => SessionListScopeActionController;
  retentionScopeKey: string;
}>;
const sessionListOwners = new Map<string, SessionListActionOwner>();
function sessionListOwnerKey(storage: string, contextKey: string): string {
  return JSON.stringify([storage, contextKey]);
}

export function registerSessionListScopeActionOwner(read: () => SessionListScopeActionController): () => void {
  const controller = read();
  const key = sessionListOwnerKey(controller.corpusStorage, controller.viewContextKey);
  const owner = { read, retentionScopeKey: controller.retentionScopeKey };
  sessionListOwners.set(key, owner);
  return () => { if (sessionListOwners.get(key) === owner) sessionListOwners.delete(key); };
}

export type ShellColumnActionOwner = Readonly<{
  present: boolean;
  visible: boolean;
  available: boolean;
  tabs?: readonly string[];
  activeTab?: string;
  label?: string;
  arrangementAvailable?: boolean;
  selectTab?(tab: string): void;
  setVisible(visible: boolean): void;
}>;

const columnOwners = new Map<ShellColumn, () => ShellColumnActionOwner>();
export type FileEditorActionOwner = Readonly<{
  tabId: string;
  serverId: string | null;
  accountId: string | null;
  save(): Promise<ScopeActionOutputById['file.editor.save']>;
  resolve(resolution: ScopeActionInputById['file.editor.resolve']['resolution']): Promise<ScopeActionOutputById['file.editor.resolve']>;
}>;
const fileEditorOwners = new Set<Readonly<{ read: () => FileEditorActionOwner }>>();

/** The registration carries commands only; the mounted file hook remains the buffer and write owner. */
export function registerFileEditorActionOwner(read: () => FileEditorActionOwner): () => void {
  // Tab ids are scope-local; the token gives each mounted registration its exact cleanup.
  const owner = { read };
  fileEditorOwners.add(owner);
  return () => { fileEditorOwners.delete(owner); };
}

export type FileViewActionOwner = Readonly<{
  tabId: string;
  active: boolean;
  serverId: string | null;
  accountId: string | null;
  mode: FileViewMode;
  changesScope?: FileChangesScope;
  blame: boolean;
  availableModes: readonly FileViewMode[];
  blameAvailable: boolean;
  changesScopeAvailable: boolean;
  set(patch: Omit<ScopeActionInputById['file.view.set'], 'tabId'>): boolean;
}>;
const fileViewOwners = new Map<string, () => FileViewActionOwner>();

/** Mounted controller bridge only: the pane tab remains the sole view-state owner. */
export function registerFileViewActionOwner(key: string, read: () => FileViewActionOwner): () => void {
  fileViewOwners.set(key, read);
  return () => { if (fileViewOwners.get(key) === read) fileViewOwners.delete(key); };
}
let readLibraryOwner: (() => WorkflowLibraryViewController) | null = null;

/** The focused Library joins the same client-local view-control bridge as Sessions and shell chrome. */
export function registerWorkflowLibraryScopeActionOwner(read: () => WorkflowLibraryViewController): () => void {
  readLibraryOwner = read;
  return () => { if (readLibraryOwner === read) readLibraryOwner = null; };
}

export function registerShellColumnActionOwner(column: ShellColumn, read: () => ShellColumnActionOwner): () => void {
  columnOwners.set(column, read);
  return () => { if (columnOwners.get(column) === read) columnOwners.delete(column); };
}

export function readShellColumnActionOwner(column: ShellColumn): ShellColumnActionOwner | null {
  return columnOwners.get(column)?.() ?? null;
}

function unavailable(errorCode: 'client_surface_unavailable' | 'client_control_unavailable') {
  return { ok: false, errorCode, error: errorCode };
}

function readSessionListOwner(input: ScopeActionInputById['session.list.view.get']): SessionListScopeActionController | null {
  const view = input.view ?? { kind: 'global' };
  const viewContext = view.kind === 'global' ? view : { kind: 'team' as const, team: { serverId: view.serverId, teamId: view.teamId } };
  const context = resolveSessionListViewContextDefaults(viewContext, [], 'all');
  const storage = input.storage ?? 'active';
  const owner = sessionListOwners.get(sessionListOwnerKey(storage, context.contextKey));
  const controller = owner?.read();
  return controller?.viewContextKey === context.contextKey && controller.corpusStorage === storage
    && controller.retentionScopeKey === owner?.retentionScopeKey ? controller : null;
}

export async function invokeScopeAction(actionId: ScopeActionId, rawInput: unknown,
  context?: Pick<ActionExecutorContext, 'serverId' | 'runtimeAccountId'>): Promise<unknown> {
  if (actionId === 'file.editor.save' || actionId === 'file.editor.resolve') {
    const input = ScopeActionInputSchemas[actionId].parse(rawInput);
    const owners = [...fileEditorOwners].map(owner => owner.read()).filter(owner =>
      (!input.tabId || owner.tabId === input.tabId)
      && (!context?.serverId || owner.serverId === context.serverId)
      && (!context?.runtimeAccountId || owner.accountId === context.runtimeAccountId));
    const owner = owners.at(-1);
    if (!owner) return { status: 'unavailable' };
    return actionId === 'file.editor.save' ? owner.save()
      : owner.resolve(ScopeActionInputSchemas['file.editor.resolve'].parse(rawInput).resolution);
  }
  if (actionId === 'file.view.get' || actionId === 'file.view.set') {
    const input = ScopeActionInputSchemas[actionId].parse(rawInput);
    const owners = [...fileViewOwners.values()].map(read => read()).filter(owner =>
      (input.tabId ? owner.tabId === input.tabId : owner.active)
      && (!context?.serverId || owner.serverId === context.serverId)
      && (!context?.runtimeAccountId || owner.accountId === context.runtimeAccountId));
    // Ambiguous unaddressed surfaces cannot choose another page's state.
    const owner = owners.length === 1 ? owners[0] : null;
    if (!owner) return unavailable('client_surface_unavailable');
    if (actionId === 'file.view.get') return { tabId: owner.tabId, mode: owner.mode, blame: owner.blame,
      ...(owner.changesScope ? { changesScope: owner.changesScope } : {}) };
    const { tabId: _tabId, ...patch } = ScopeActionInputSchemas['file.view.set'].parse(rawInput);
    if ((patch.mode !== undefined && !owner.availableModes.includes(patch.mode))
      || (patch.blame !== undefined && !owner.blameAvailable)
      || (patch.changesScope !== undefined && !owner.changesScopeAvailable)) return unavailable('client_control_unavailable');
    return owner.set(patch) ? { ok: true } : unavailable('client_control_unavailable');
  }
  if (actionId === 'workflow.library.view.get' || actionId === 'workflow.library.view.set' || actionId === 'workflow.library.view.reset') {
    const controller = readLibraryOwner?.();
    if (!controller?.focused || !controller.lifetime?.isCurrent()
      || (context?.serverId && !selectActiveServerAccountScopeForServer(controller.lifetime.scope, context.serverId))
      || (context?.runtimeAccountId && context.runtimeAccountId !== controller.lifetime.scope.accountId)) {
      return unavailable('client_surface_unavailable');
    }
    ScopeActionInputSchemas[actionId].parse(rawInput);
    if (actionId === 'workflow.library.view.get') return {
      view: controller.view, searchQuery: controller.searchQuery,
      offeredViews: controller.offeredViews, visibleKeys: controller.visibleKeys,
    };
    const patch = actionId === 'workflow.library.view.reset' ? { view: 'all' as const, searchQuery: '' }
      : ScopeActionInputSchemas['workflow.library.view.set'].parse(rawInput);
    return controller.update(patch) ? { ok: true } : unavailable('client_control_unavailable');
  }
  if (actionId === 'shell.column.get' || actionId === 'shell.column.set') {
    const input = ScopeActionInputSchemas[actionId].parse(rawInput);
    const columnId = input.column ?? 'navigation';
    const column = readShellColumnActionOwner(columnId);
    if (!column) return unavailable('client_surface_unavailable');
    if (actionId === 'shell.column.get') return { present: column.present, visible: column.visible, available: column.available,
      ...(column.tabs ? { tabs: column.tabs } : {}), ...(column.activeTab === undefined ? {} : { activeTab: column.activeTab }),
      ...(column.label === undefined ? {} : { label: column.label }) };
    const update = ScopeActionInputSchemas['shell.column.set'].parse(rawInput);
    if (!column.present || !column.available) return unavailable('client_control_unavailable');
    if (update.tab !== undefined) {
      if (columnId !== 'side' || !column.selectTab || !column.tabs?.includes(update.tab)) return unavailable('client_control_unavailable');
      column.selectTab(update.tab);
    }
    column.setVisible(update.tab === undefined ? update.visible : true);
    return { ok: true };
  }
  const input = ScopeActionInputSchemas[actionId].parse(rawInput);
  const controller = readSessionListOwner(input);
  if (!controller) return unavailable('client_surface_unavailable');
  if (actionId === 'session.list.view.get') return {
    view: controller.viewContext.kind === 'global' ? { kind: 'global' } : { kind: 'team', ...controller.viewContext.team },
    storage: controller.corpusStorage,
    filters: controller.filters,
    includeInactive: controller.includeInactive,
    queryEnabled: controller.queryEnabled,
    followingAvailable: controller.followingAvailable,
    sourceAvailable: controller.sourceAvailable,
    homes: controller.homeOptions,
  };
  if (actionId === 'session.list.view.reset') {
    controller.resetFilters();
    return { ok: true };
  }
  const update = ScopeActionInputSchemas['session.list.view.set'].parse(rawInput);
  const patch = update.filters ?? {};
  const requestedHomes = patch.homeServerIds === undefined ? undefined : normalizeSessionListFilterHomeIds(patch.homeServerIds);
  const scopeAvailability = resolveSessionListFilterScopeAvailability(controller);
  if ((patch.scope !== undefined && !scopeAvailability[patch.scope])
    || (patch.attention !== undefined && !controller.queryEnabled)
    || (patch.audiences !== undefined && !controller.queryEnabled)
    || (patch.source !== undefined && !controller.sourceAvailable)
    || (update.includeInactive !== undefined && controller.corpusStorage === 'archived')
    || (requestedHomes?.some((id) => !controller.homeOptions.some((home) => home.serverId === id)))
    || (controller.fixedHomeServerIds && requestedHomes !== undefined
      && (requestedHomes.some((id) => !controller.fixedHomeServerIds?.has(id))
        || [...controller.fixedHomeServerIds].some((id) => !requestedHomes.includes(id))))) {
    return unavailable('client_control_unavailable');
  }
  const { source, ...filterPatch } = patch;
  if (Object.keys(filterPatch).length > 0) controller.updateFilters((current) => ({ ...current, ...filterPatch }));
  // The existing device preference writer remains authoritative for these facets.
  if (source !== undefined) controller.setSource(source);
  if (update.includeInactive !== undefined) controller.setIncludeInactive(update.includeInactive);
  return { ok: true };
}
