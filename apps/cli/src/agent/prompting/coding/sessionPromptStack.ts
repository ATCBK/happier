import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { assertPromptStackArtifactHeaderV1, hasRequiredPromptStackSystemAppendEntriesV1, PromptStackPreparationError, type PromptStackScopeV1 } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { readRetainedPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { migrateRetainedSessionWorkContextV1, readSessionMemoryEnabledV1, SessionDisabledInheritedEntryIdsV1Schema,
  SessionPromptStackV1Schema } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { Metadata } from '@/api/types';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { sameStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, readActiveAccountPromptStackSources,
  readAccountPromptStackSources,
  readAccountProfilePromptStackSources,
  isActiveAccountSettingsSnapshotLifetimeCurrent,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveSessionProjectPromptStack } from './sessionProjectPromptStack';
import { withCliPromptLibraryArtifactReader } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

/** Birth copies Session memory attachments, not document bodies or the lead's instructions/identity.
 * Account/Profile/Project context continues to resolve through the worker's own composition. */
export async function prepareSessionMemoryInheritance(input: Readonly<{
  metadata: Readonly<Record<string, unknown>> | null;
  credentials?: StoredCredentials;
  serverId?: string;
  signal?: AbortSignal;
}>): Promise<Readonly<{ memoryEnabled: boolean; promptStack: PromptStackEntryV1[] }>> {
  input.signal?.throwIfAborted();
  const memoryEnabled = readSessionMemoryEnabledV1(input.metadata);
  const work = migrateRetainedSessionWorkContextV1(input.metadata?.work);
  const entries = createStoredReadSchema(SessionPromptStackV1Schema).parse(work.promptStack ?? [])
    .filter(entry => entry.ref.kind === 'doc' && entry.id !== 'session.instructions');
  if (entries.length === 0) return { memoryEnabled, promptStack: [] };
  // Birth inheritance must read with its Session owner's material, never the
  // ambient Account selected by the generic prompt-library reader.
  if (!input.credentials) throw Object.assign(new Error('context_source_unavailable'), { code: 'context_source_unavailable' });
  return withCliPromptLibraryArtifactReader(async reader => {
    const scope = await reader.readScope();
    if (!scope) throw Object.assign(new Error('context_source_unavailable'), { code: 'context_source_unavailable' });
    const promptStack: PromptStackEntryV1[] = [];
    for (const entry of entries) {
      const ref = { ...entry.ref, serverId: entry.ref.serverId ?? scope.serverId };
      // Birth inheritance is same-Home/Account only. Never select saved credentials for another Home.
      if (ref.serverId !== scope.serverId) throw new PromptStackPreparationError('unavailable', ref);
      const artifact = await reader.readArtifactHeader(ref);
      if (!artifact) throw new PromptStackPreparationError('unavailable', ref);
      assertPromptStackArtifactHeaderV1(ref, artifact.header, { layer: 'session', entryId: entry.id, memoryEnabled });
      if (artifact.header?.kind === 'memory_doc.v1') promptStack.push({ ...entry, ref });
    }
    input.signal?.throwIfAborted();
    return { memoryEnabled, promptStack };
  }, input);
}

/** The Session producer retains its original Account lifetime and supplies its legacy Settings basis. */
export type SessionPromptStackAccountContext = Readonly<{
  scopeKey: string | null;
  lifetimeToken: number;
  settings: Record<string, unknown> | null;
}>;

export type SessionPromptStackInput = Readonly<{
  credentials?: StoredCredentials;
  metadata: Metadata | Readonly<Record<string, unknown>> | null;
  sessionId?: string;
  machineId: string;
  directory?: string;
  serverId?: string;
  signal?: AbortSignal;
  /** Search admission refreshes attachment membership through the incumbent catalog loaders. */
  refreshCatalogs?: boolean;
  /** Preserve the caller's original Account admission across asynchronous preparation. */
  accountContext?: SessionPromptStackAccountContext;
  operationContext?: SavedSecretOperationContextV1;
  /** Coding augmentation may omit unknown inventory; corpus admission remains strict. */
  allowOptionalAccountLibrary?: boolean;
  /** Prior canonical selections prevent omission only; never fallback read inputs. */
  knownAccountEntries?: readonly PromptStackEntryV1[];
}>;

export type PreparedSessionPromptStackInputs = Readonly<{
  credentials?: StoredCredentials;
  operationContext?: SavedSecretOperationContextV1;
  serverId: string;
  scope: PromptStackScopeV1 | null;
  settings: Record<string, unknown> | null;
  profileId: string | null;
  profileCatalog?: ProfileCatalogSnapshotV1;
  accountEntries?: readonly PromptStackEntryV1[];
  profileEntries?: readonly PromptStackEntryV1[];
  sessionEntries: readonly PromptStackEntryV1[];
  projectEntries: readonly PromptStackEntryV1[];
  memoryEnabled: boolean;
  createdAsBot: boolean;
  disabledInheritedEntryIds: readonly string[];
  accountSnapshot: ActiveAccountSettingsSnapshot | null;
  optionalAccountLibraryUnavailable?: Readonly<{ status: 'unavailable'; reason: string }>;
  /** Recheck after document reads, including failed preparation, before publishing private facts. */
  assertCurrentAccount: () => void;
}>;

/** One input owner for coding preparation and fresh daemon document admission; selection stays in Protocol. */
export async function prepareSessionPromptStackInputs(input: SessionPromptStackInput): Promise<PreparedSessionPromptStackInputs> {
  input.signal?.throwIfAborted();
  const accountContext = input.accountContext ?? {
    scopeKey: input.credentials ? resolveAccountSettingsScopeKey(input.credentials) : null,
    lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
    settings: null,
  };
  const unavailable = (reason?: string): never => {
    throw Object.assign(new Error('context_source_unavailable'), {
      code: 'context_source_unavailable', status: 'preparation_pending', ...(reason ? { reason } : {}),
    });
  };
  const readCurrentAccount = (): ActiveAccountSettingsSnapshot | null => {
    input.signal?.throwIfAborted();
    if (!accountContext.scopeKey) return null;
    const current = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
    if (!current || current.scopeKey !== accountContext.scopeKey
      || !isActiveAccountSettingsSnapshotLifetimeCurrent({ scopeKey: accountContext.scopeKey, lifetimeToken: accountContext.lifetimeToken })
      || (input.credentials && resolveAccountSettingsScopeKey(input.credentials) !== accountContext.scopeKey)) {
      return unavailable();
    }
    return current;
  };
  const assertCurrentAccount = () => { readCurrentAccount(); };
  const assertOperationCurrent = async () => {
    assertCurrentAccount();
    if (input.operationContext && (!input.credentials
      || !sameStoredCredentials(input.operationContext.credentials, input.credentials)
      || !await input.operationContext.isCurrent())) return unavailable('scope-retired');
    assertCurrentAccount();
  };
  try {
    await assertOperationCurrent();
    const serverId = input.serverId ?? input.credentials?.requesterSessionCredentialScope?.serverId ?? configuration.activeServerId;
    const accountId = input.credentials ? readAccountIdFromToken(input.credentials.token) : null;
    const metadata = input.metadata;
    const profileId = typeof metadata?.profileId === 'string' ? metadata.profileId : null;
    const projectId: unknown = metadata ? Reflect.get(metadata, 'projectId') : undefined;
    const workspaceId: unknown = metadata ? Reflect.get(metadata, 'workspaceId') : undefined;
    const projectKey = typeof projectId === 'string' ? projectId.trim() : undefined;
    const scope: PromptStackScopeV1 | null = accountId ? {
      serverId, accountId, ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(projectKey ? { projectKey } : {}), ...(profileId ? { profileId } : {}),
    } : null;
    let currentAccount = readCurrentAccount();
    const observedBeforeDemand = currentAccount ? readAccountPromptStackSources(currentAccount, { surface: 'coding' }) : null;
    if (accountContext.scopeKey && currentAccount && input.credentials) {
      const demand: Promise<unknown>[] = [];
      const { prepareActivePromptLibraryRecord, refreshActivePromptLibraryCatalog } = await import('@/settings/prompts/hydratePromptLibraryCatalog');
      // Import completion cannot admit a replacement Account lifetime.
      assertCurrentAccount();
      demand.push(input.refreshCatalogs && !input.operationContext
        ? refreshActivePromptLibraryCatalog({ credentials: input.credentials, signal: input.signal })
        : prepareActivePromptLibraryRecord({ credentials: input.credentials, scopeKey: accountContext.scopeKey,
            lifetimeToken: accountContext.lifetimeToken, key: 'coding', signal: input.signal, operationContext: input.operationContext }));
      if (profileId && (input.refreshCatalogs || currentAccount.profileCatalog?.status !== 'ready')) {
        const { refreshActiveProfileCatalog } = await import('@/settings/profiles/hydrateProfileCatalog');
        assertCurrentAccount();
        demand.push(refreshActiveProfileCatalog({ credentials: input.credentials, signal: input.signal, operationContext: input.operationContext }));
      }
      await Promise.all(demand);
      await assertOperationCurrent();
      currentAccount = readCurrentAccount();
    }
    const settings = currentAccount?.settings ?? accountContext.settings;
    const work = migrateRetainedSessionWorkContextV1(metadata?.work);
    const sessionEntries = createStoredReadSchema(SessionPromptStackV1Schema).parse(work.promptStack ?? []);
    const disabledInheritedEntryIds = createStoredReadSchema(SessionDisabledInheritedEntryIdsV1Schema).parse(work.disabledInheritedEntryIds ?? []);
    const sourceSelection = { surface: 'coding' as const, profileId };
    const accountSources = accountContext.scopeKey ? input.operationContext && currentAccount
      ? readAccountPromptStackSources(currentAccount, sourceSelection) : readActiveAccountPromptStackSources({
      scopeKey: accountContext.scopeKey, lifetimeToken: accountContext.lifetimeToken, surface: 'coding', profileId,
    }) : null;
    let optionalAccountLibraryUnavailable: PreparedSessionPromptStackInputs['optionalAccountLibraryUnavailable'];
    let profileEntries: readonly PromptStackEntryV1[] | undefined;
    if (accountSources?.status === 'unavailable') {
      const reason = accountSources.reason;
      const optionalAvailability = reason === 'catalog-unobserved' || reason === 'loading' || reason === 'unreachable'
        || reason === 'unsupported' || reason === 'source-version-conflict' || reason === 'authority-not-confirmed';
      if (!input.allowOptionalAccountLibrary || !optionalAvailability || !currentAccount) return unavailable(reason);
      let knownEntries = input.knownAccountEntries ?? (observedBeforeDemand?.status === 'ready' ? observedBeforeDemand.accountEntries : undefined);
      if (knownEntries === undefined && currentAccount.source !== 'none' && currentAccount.rawSettings) {
        const retained = readRetainedPromptLibraryRecordV1(currentAccount.rawSettings, 'coding');
        if (retained.status !== 'ready' || retained.record.key !== 'coding') return unavailable('invalid-stored-content');
        knownEntries = retained.record.value.entries;
      }
      const requiredness = { surface: 'coding' as const, accountEntries: knownEntries ?? [], disabledInheritedEntryIds,
        memoryEnabled: readSessionMemoryEnabledV1(metadata), scope, signal: input.signal };
      let required = await hasRequiredPromptStackSystemAppendEntriesV1(requiredness);
      if (required && requiredness.memoryEnabled === false && input.credentials) {
        required = await withCliPromptLibraryArtifactReader(reader => hasRequiredPromptStackSystemAppendEntriesV1({
          ...requiredness, readArtifactHeader: reader.readArtifactHeader,
        }), input);
      }
      if (required) return unavailable(reason);
      const profile = readAccountProfilePromptStackSources(currentAccount, sourceSelection);
      if (profile.status !== 'ready') return unavailable(profile.reason);
      profileEntries = profile.profileEntries;
      optionalAccountLibraryUnavailable = { status: 'unavailable', reason };
    }
    if (!input.credentials && (workspaceId !== undefined || projectId !== undefined)) return unavailable();
    const projectEntries = input.credentials ? await resolveSessionProjectPromptStack({
      credentials: input.credentials, metadata, signal: input.signal, machineId: input.machineId, directory: input.directory, serverId,
      operationContext: input.operationContext,
    }).then(project => project.entries) : [];
    await assertOperationCurrent();
    return {
      credentials: input.credentials, operationContext: input.operationContext, serverId, scope, settings, profileId,
      ...(currentAccount?.profileCatalog ? { profileCatalog: currentAccount.profileCatalog } : {}),
      ...(accountSources?.status === 'ready' ? { accountEntries: accountSources.accountEntries, profileEntries: accountSources.profileEntries } : {}),
      ...(optionalAccountLibraryUnavailable ? { accountEntries: [], profileEntries, optionalAccountLibraryUnavailable } : {}),
      sessionEntries, projectEntries, memoryEnabled: readSessionMemoryEnabledV1(metadata),
      createdAsBot: metadata?.createdAsBot === true, disabledInheritedEntryIds, accountSnapshot: currentAccount, assertCurrentAccount,
    };
  } catch (error) {
    await assertOperationCurrent();
    throw error;
  }
}
