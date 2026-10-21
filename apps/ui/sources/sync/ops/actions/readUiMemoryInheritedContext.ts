import type { ActionExecutorContext, MemoryInheritedContextV1, MemorySessionSnapshotV1, MemoryScopeContextV1, MemoryScopeTargetV1 } from '@happier-dev/protocol/actions/executor/types';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { readSessionProjectWorkspaceAddressV1, resolveSessionProjectWorkspaceRefV1, projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { readPromptLibraryCatalogProjectionInContext, writePromptLibraryRecordAndPublishInContext } from '@/sync/api/account/apiPromptLibraryCatalog';
import { canUsePrivateProjectAccountAction, createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { createUiProjectContextAction } from './projectContextAction';
import { readProjectContextAttachmentTargetV1 } from '@happier-dev/protocol/projects/projectContextV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createProjectSourceActionDeps } from '@/sync/api/projects/projectSourceActions';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import type { LazyActionAccountContext } from './actionAccountContext';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';
import { ProjectSourcesReadInputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

function pending(reason: 'project_association_unavailable' | 'project_source_unavailable'): never {
  throw Object.assign(new Error(reason), { code: 'preparation_pending', reason });
}

/** Qualified row/Source transport feeds the canonical workspace association owner. */
export async function readUiSessionProjectPromptStack(account: LazyActionAccountContext, snapshot: MemorySessionSnapshotV1,
  context: ActionExecutorContext): Promise<readonly PromptStackEntryV1[]> {
  const metadata = snapshot.metadata;
  const machineId = resolveSessionMachineId(metadata);
  const prepared = readSessionProjectWorkspaceAddressV1({ metadata, machineId });
  if (prepared.kind === 'none') return [];
  if (prepared.kind === 'pending') return pending(prepared.reason);
  let rows: Awaited<ReturnType<ReturnType<typeof createUiProjectAccountRowsClient>['read']>>;
  try { rows = await createUiProjectAccountRowsClient(account).read(context.signal); }
  catch { account.assertCurrent(); context.signal?.throwIfAborted(); return pending('project_association_unavailable'); }
  account.assertCurrent();
  const resolved = resolveSessionProjectWorkspaceRefV1(rows.workspaceRefs, { serverId: account.serverId, address: prepared.address });
  if (resolved.kind === 'none') return [];
  if (resolved.kind === 'pending') return pending(resolved.reason);
  const project = projectWorkspaceRefV1(resolved.ref);
  const personal = rows.organizations.find(row => row.key.serverId === account.serverId
    && row.key.projectKey === project.projectKey)?.value.promptStack ?? [];
  let shared: readonly PromptStackEntryV1[] = [];
  if (resolved.ref.source) {
    const result = await createProjectSourceActionDeps(account).projectSourcesRead({ serverId: account.serverId,
      sourceId: resolved.ref.source.sourceId }, context);
    account.assertCurrent(); context.signal?.throwIfAborted();
    if (!result.ok) return pending('project_source_unavailable');
    shared = (result.source.attachments ?? []).flatMap(attachment => attachment.purpose === 'context' ? [attachment.entry] : []);
  }
  return (resolved.ref.source ? shared : personal).map(entry => ({ ...entry, ref: { ...entry.ref, serverId: entry.ref.serverId ?? account.serverId } }));
}

/** Destination selection stays in the shared Action owner; Account attachments use captured coding-row CAS. */
export async function readUiMemoryInheritedContext(account: LazyActionAccountContext, snapshot: MemorySessionSnapshotV1,
  context: ActionExecutorContext): Promise<MemoryInheritedContextV1> {
  account.assertCurrent(); context.signal?.throwIfAborted();
  const projectEntries = await readUiSessionProjectPromptStack(account, snapshot, context);
  return { projectEntries, readAccountContext: async () => {
    const captured = await readUiMemoryAccountContext(account, context);
    return { accountEntries: captured.entries, attachAccountMemory: captured.attachMemory };
  } };
}

async function readUiMemoryAccountContext(account: LazyActionAccountContext,
  context: ActionExecutorContext): Promise<MemoryScopeContextV1> {
    account.assertCurrent(); context.signal?.throwIfAborted();
    const projection = await readPromptLibraryCatalogProjectionInContext(account, context.signal);
    const read = readPromptLibraryCatalogRecordV1({ catalog: projection.catalog, key: 'coding', rawSettings: projection.rawSettings });
    account.assertCurrent(); context.signal?.throwIfAborted();
    if (read.status !== 'ready' || read.record.key !== 'coding') throw Object.assign(new Error('memory_target_unavailable'), {
      code: read.status === 'unavailable' ? read.reason : 'memory_target_unavailable',
    });
    const record = read.record;
    return { entries: record.value.entries, safety: 'safe',
      attachMemory: async ref => {
        account.assertCurrent(); context.signal?.throwIfAborted();
        if (record.value.entries.some(entry => entry.id === 'account.memory')) return false;
        const result = await writePromptLibraryRecordAndPublishInContext(account, { record: { ...record,
          value: { ...record.value, entries: [...record.value.entries,
            { id: 'account.memory', ref, enabled: true, placement: 'system_append' }] } }, expectedRevision: read.revision,
          ...(read.authority === 'inactive' ? { sourceSettingsVersion: projection.sourceSettingsVersion } : {}) }, context.signal);
        if (result.status === 'conflict' || result.status === 'settings-conflict') return false;
        if (result.status !== 'updated') throw Object.assign(new Error(result.status), { code: result.status });
        return true;
      } };
}

/** Both personal and shared context targets consume the single Project attachment owner. */
export async function readUiMemoryScopeContext(account: LazyActionAccountContext, target: MemoryScopeTargetV1,
  context: ActionExecutorContext): Promise<MemoryScopeContextV1> {
  const rows = createUiProjectAccountRowsClient(account);
  const sources = createProjectSourceActionDeps(account);
  return readUiMemoryScopeContextWithRows(account, target, context, () => rows.read(context.signal), sources.projectSourcesRead);
}

type ReadRows = () => ReturnType<ReturnType<typeof createUiProjectAccountRowsClient>['read']>;
type ReadSource = ReturnType<typeof createProjectSourceActionDeps>['projectSourcesRead'];

async function readUiMemoryScopeContextWithRows(account: LazyActionAccountContext, target: MemoryScopeTargetV1,
  context: ActionExecutorContext, readRows: ReadRows, readSource: ReadSource): Promise<MemoryScopeContextV1> {
  account.assertCurrent(); context.signal?.throwIfAborted();
  if (target.scope === 'account') return readUiMemoryAccountContext(account, context);
  if (!areServerProfileIdentifiersEquivalent(target.projectRef.serverId, account.serverId)
    || !canUsePrivateProjectAccountAction(account, context)) {
    throw Object.assign(new Error('project_context_access_denied'), { code: 'project_context_access_denied' });
  }
  const sources = createProjectSourceActionDeps(account);
  const updatePersonalContext = createUiProjectContextAction(account);
  const project = await readProjectContextAttachmentTargetV1({
    readRows: async () => {
      const current = await readRows();
      account.assertCurrent(); context.signal?.throwIfAborted();
      return current;
    },
    readSource: input => readSource(input, context),
    updateSource: input => sources.projectSourcesUpdate(input, context),
    updatePersonalContext: input => updatePersonalContext(input, context),
  }, { ...target.projectRef, serverId: account.serverId });
  return { entries: project.entries, safety: project.safety,
    attachMemory: ref => project.attach({ id: 'project.memory', ref, enabled: true, placement: 'system_append' }) };
}

/** The opened Project catalog supplies choices; the same scope owner proves attachment write eligibility. */
export async function readUiMemoryDecisionTargetContexts(account: LazyActionAccountContext, context: ActionExecutorContext) {
  account.assertCurrent(); context.signal?.throwIfAborted();
  const targets: Array<Readonly<{ target: MemoryScopeTargetV1; context: MemoryScopeContextV1;
    workspaceRef: WorkspaceRefV1 | null; label: string | null }>> = [];
  let coverage: 'complete' | 'partial' = 'complete';
  try {
    targets.push({ target: { scope: 'account' }, context: await readUiMemoryAccountContext(account, context), workspaceRef: null, label: null });
  } catch { account.assertCurrent(); context.signal?.throwIfAborted(); coverage = 'partial'; }
  let rows: Awaited<ReturnType<ReadRows>>;
  try { rows = await createUiProjectAccountRowsClient(account).read(context.signal); }
  catch {
    account.assertCurrent(); context.signal?.throwIfAborted();
    return { targets, coverage: 'partial' as const };
  }
  account.assertCurrent(); context.signal?.throwIfAborted();
  const projection = projectProjectListV1({ serverId: account.serverId, workspaceRefs: rows.workspaceRefs, organizations: rows.organizations, includeHidden: true });
  const groups = new Map([...projection.projectGroups, ...projection.hiddenProjectGroups].map(group => [group.projectKey.projectKey, group]));
  const keys = new Set([...groups.keys(), ...rows.organizations.filter(row => areServerProfileIdentifiersEquivalent(row.key.serverId, account.serverId)).map(row => row.key.projectKey)]);
  const sources = createProjectSourceActionDeps(account);
  const sourceReads = new Map<string, ReturnType<ReadSource>>();
  const readSource: ReadSource = (input, sourceContext) => {
    const key = ProjectSourcesReadInputV1Schema.parse(input).sourceId;
    let read = sourceReads.get(key);
    if (!read) { read = sources.projectSourcesRead(input, sourceContext); sourceReads.set(key, read); }
    return read;
  };
  const projects = await Promise.all([...keys].map(async projectKey => {
    const target = { scope: 'project' as const, projectRef: { serverId: account.serverId, projectKey } };
    try {
      const admitted = await readUiMemoryScopeContextWithRows(account, target, context, async () => rows, readSource);
      const organization = rows.organizations.find(row => row.key.serverId === account.serverId && row.key.projectKey === projectKey);
      return { target, context: admitted, workspaceRef: groups.get(projectKey)?.items[0] ?? null, label: organization?.value.label ?? null };
    } catch (error) {
      account.assertCurrent(); context.signal?.throwIfAborted();
      // An admitted read-only Source is ineligible; an unavailable read cannot establish absence.
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'project_context_access_denied')) coverage = 'partial';
      return null;
    }
  }));
  account.assertCurrent(); context.signal?.throwIfAborted();
  targets.push(...projects.filter((row): row is NonNullable<typeof row> => row !== null));
  return { targets, coverage };
}
