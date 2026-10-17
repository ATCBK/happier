import { createHash, randomUUID } from 'node:crypto';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';

import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { APPROVAL_ARTIFACT_KINDS_V1, approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1, buildExecutionRunHostActionApprovalArtifactHeaderV1, buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionId, ApprovalQueueListItemV1, ApprovalRequest, ExecutionRunHostActionApprovalRequestV1, TargetActionApprovalRequestV1, PromptLibraryArtifactStore } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import {
  createConnectedServiceCredentialApi,
  type ConnectedServiceAccountEncryptionMode,
} from '@/api/client/connectedServiceCredentialApi';
import { createAccountArtifactStore, encodeAccountArtifactListCursor, type AccountArtifact } from '@/api/artifacts/accountArtifactStore';
import type { PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { listArtifactHeadersV1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ArtifactFolderActionPortV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import type { SkillRulesActionPortV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import { readSkillLibraryCatalog } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';
import { readAccountPluginSkills } from '@/prompts/skills/library/readAccountPluginSkills';
import type { SkillActionPortV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

import { targetActionApprovalRequestsEqual, targetActionApprovalSubjectsEqual } from './targetActionApprovalSubject';
import {
  executionRunHostActionApprovalRequestsEqual,
  executionRunHostActionApprovalSubjectsEqual,
} from './executionRunHostActionApprovalSubject';

/** One adaptation of an already-readable Account Artifact for the Prompt owner. */
export function projectAccountArtifactToPromptLibraryStoredArtifact(artifact: AccountArtifact | null): PromptLibraryStoredArtifact | null {
  if (!artifact || typeof artifact.body !== 'string') return null;
  return { id: artifact.artifactId, revision: artifact.revision, header: artifact.header, body: artifact.body,
    owned: artifact.access === 'owner', access: artifact.access };
}

function parseApprovalStatus(value: unknown): ApprovalRequest['status'] | null {
  if (
    value === 'open'
    || value === 'approved'
    || value === 'executing'
    || value === 'rejected'
    || value === 'executed'
    || value === 'failed'
    || value === 'canceled'
  ) {
    return value;
  }
  return null;
}

function parseApprovalActionId(value: unknown): ActionId | null {
  return typeof value === 'string' && ActionIdSchema.safeParse(value).success ? value as ActionId : null;
}

function normalizeArtifactServerId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function approvalArtifactMatchesServerScope(
  header: Record<string, unknown>,
  serverId: string | null,
): boolean {
  if (!serverId) return true;
  return normalizeArtifactServerId(header.serverId) === serverId;
}

function readBuiltInApprovalArtifact(header: Record<string, unknown>, body: unknown): ApprovalRequest | null {
  if (typeof body !== 'string') return null;
  const parsed = approvalArtifactBodyMatchesHeaderV1(header, body);
  return parsed?.family === 'built_in' ? parsed.request : null;
}

function readTargetActionApprovalArtifact(header: Record<string, unknown>, body: unknown): TargetActionApprovalRequestV1 | null {
  if (typeof body !== 'string') return null;
  const parsed = approvalArtifactBodyMatchesHeaderV1(header, body);
  return parsed?.family === 'target_action' ? parsed.request : null;
}

function readExecutionRunHostActionApprovalArtifact(header: Record<string, unknown>, body: unknown): ExecutionRunHostActionApprovalRequestV1 | null {
  if (typeof body !== 'string') return null;
  const parsed = approvalArtifactBodyMatchesHeaderV1(header, body);
  return parsed?.family === 'execution_run_host_action' ? parsed.request : null;
}

function derivePluginInstallApprovalSuccessorArtifactId(artifactId: string): string {
  const bytes = createHash('sha256')
    .update('happier-plugin-install-approval-successor-v1\0', 'utf8')
    .update(artifactId, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createCliApprovalsArtifactStore(params: Readonly<{
  credentials: StoredCredentials;
  serverId?: string;
  serverHttpBaseUrl?: string;
  operationContext?: SavedSecretOperationContextV1;
  getAccountEncryptionMode?: () => Promise<ConnectedServiceAccountEncryptionMode>;
}>): Readonly<{
  approvalsList: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsList']>;
  approvalsCreate: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsCreate']>;
  approvalsGet: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsGet']>;
  approvalsUpdate: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsUpdate']>;
  targetActionApprovalsCreate(args: Readonly<{ request: TargetActionApprovalRequestV1 }>): Promise<Readonly<{ artifactId: string }>>;
  targetActionApprovalsGet(args: Readonly<{ artifactId: string }>): Promise<TargetActionApprovalRequestV1 | null>;
  targetActionApprovalsUpdate(args: Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>): Promise<Readonly<{ ok: true } | { ok: false; errorCode: string; error: string }>>;
  executionRunHostActionApprovalsCreate(args: Readonly<{ request: ExecutionRunHostActionApprovalRequestV1 }>): Promise<Readonly<{ artifactId: string }>>;
  executionRunHostActionApprovalsGet(args: Readonly<{ artifactId: string }>): Promise<ExecutionRunHostActionApprovalRequestV1 | null>;
  executionRunHostActionApprovalsUpdate(args: Readonly<{ artifactId: string; request: ExecutionRunHostActionApprovalRequestV1 }>): Promise<Readonly<{ ok: true } | { ok: false; errorCode: string; error: string }>>;
  promptLibraryStore: PromptLibraryArtifactStore;
  skillRules: SkillRulesActionPortV1;
  readPluginSkills: NonNullable<SkillActionPortV1['readPluginSkills']>;
}> {
  const accountModeApi = params.getAccountEncryptionMode
    ? null
    : createConnectedServiceCredentialApi(params.credentials);
  const getAccountEncryptionMode = params.getAccountEncryptionMode
    ?? (() => accountModeApi!.getAccountEncryptionMode());
  const rawAccountArtifactStore = createAccountArtifactStore({
    credentials: params.credentials,
    getAccountEncryptionMode: () => timeWebLatencyPhase('approval.account_mode', getAccountEncryptionMode),
  });
  const accountArtifactStore = { ...rawAccountArtifactStore,
    read: (...args: Parameters<typeof rawAccountArtifactStore.read>) => timeWebLatencyPhase('approval.artifact.read', () => rawAccountArtifactStore.read(...args)),
    update: (...args: Parameters<typeof rawAccountArtifactStore.update>) => timeWebLatencyPhase('approval.artifact.update', () => rawAccountArtifactStore.update(...args)),
  };
  const folderBaseUrl = params.operationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const folderStore = runWithServerHttpBaseUrl(folderBaseUrl,
    () => createCliPromptLibraryStore({ credentials: params.credentials, operationContext: params.operationContext }));
  const folderScopeKey = runWithServerHttpBaseUrl(folderBaseUrl,()=>resolveAccountSettingsScopeKey(params.credentials));
  const folderLifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const readPluginSkills: NonNullable<SkillActionPortV1['readPluginSkills']> = (signal, skillIds) => readAccountPluginSkills({
    credentials: params.credentials, serverHttpBaseUrl: folderBaseUrl, signal, skillIds,
    settings: (params.operationContext ? params.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot())?.settings,
    isCurrent: async () => { folderStore.assertCurrent(); return params.operationContext ? params.operationContext.isCurrent() : true; },
  });
  const organization: ArtifactFolderActionPortV1 = {
    serverId: params.serverId ?? configuration.activeServerId,
    assertCurrent: folderStore.assertCurrent,
    readCatalog: async (signal, key = 'folders') => runWithServerHttpBaseUrl(folderBaseUrl, async () => {
      folderStore.assertCurrent(); signal?.throwIfAborted();
      const projection = await folderStore.readCatalog(signal, key);
      folderStore.assertCurrent(); signal?.throwIfAborted();
      return projection;
    }),
    writeRecord: async (input, signal) => runWithServerHttpBaseUrl(folderBaseUrl, async () => {
      folderStore.assertCurrent(); signal?.throwIfAborted();
      const transport = createCliPromptLibraryStore({ credentials: params.credentials, signal, operationContext: params.operationContext });
      const result = await transport.writeRecord(input);
      if (result.status === 'updated') {
        try {
          const { refreshActivePromptLibraryCatalogAfterChange,prepareActivePromptLibraryRecord } = await import('@/settings/prompts/hydratePromptLibraryCatalog');
          if(params.operationContext)await prepareActivePromptLibraryRecord({credentials:params.credentials,scopeKey:folderScopeKey,
            lifetimeToken:folderLifetimeToken,key:input.record.key,operationContext:params.operationContext});
          else await refreshActivePromptLibraryCatalogAfterChange({ credentials: params.credentials, scopeKey: folderScopeKey,
            lifetimeToken: folderLifetimeToken });
        } catch { /* A durable row receipt survives publication failure or caller cancellation. */ }
      }
      return result;
    }),
    listArtifactHeaders: async (signal) => runWithServerHttpBaseUrl(folderBaseUrl, async () => {
      const page = await listArtifactHeadersV1({ options: { includeBody: false, signal },
        readPage: async options => {
          folderStore.assertCurrent(); signal?.throwIfAborted();
          const page = await accountArtifactStore.list(options);
          folderStore.assertCurrent(); signal?.throwIfAborted();
          return page;
        }, encodeCursor: encodeAccountArtifactListCursor });
      folderStore.assertCurrent(); signal?.throwIfAborted();
      return { items: page.items.map(artifact => ({ artifactId: artifact.artifactId, header: artifact.header, owned: artifact.access === 'owner' })),
        coverage: page.nextCursor ? 'partial' : page.coverage };
    }),
    readArtifactHeader: async (artifactId, signal) => {
      const inventory = await organization.listArtifactHeaders(signal);
      const artifact = inventory.items.find(item => item.artifactId === artifactId);
      if (artifact) return { header: artifact.header, owned: artifact.owned };
      if (inventory.coverage !== 'complete') throw Object.assign(new Error('artifact_inventory_incomplete'), { code: 'artifact_inventory_incomplete' });
      return null;
    },
  };

  return {
    promptLibraryStore: {
      organization,
      list: async (options) => {
        const page = await accountArtifactStore.list(options);
        return { items: page.items.map((artifact) => ({ id: artifact.artifactId, header: artifact.header, updatedAtMs: artifact.updatedAt, owned: artifact.access === 'owner' })),
          coverage: page.coverage, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      },
      read: async (artifactId, options) => {
        const artifact = await accountArtifactStore.read(artifactId, options);
        return projectAccountArtifactToPromptLibraryStoredArtifact(artifact);
      },
      create: async ({ header, body, signal }) => {
        const created = await accountArtifactStore.create({ header, body, signal });
        return created.artifactId;
      },
      update: async ({ artifactId, expectedRevision, header, body, signal }) => {
        const updated = await accountArtifactStore.update({ artifactId,
          expectedRevision, header, body, signal });
        if (!updated.ok) throw Object.assign(new Error(updated.error), { code: updated.errorCode });
        return { revision: updated.revision };
      },
      delete: async ({ artifactId, expectedRevision, signal }) => {
        const deleted = await accountArtifactStore.delete(artifactId, { expectedRevision, signal });
        if (!deleted.ok) throw Object.assign(new Error(deleted.error), { code: deleted.errorCode });
      },
    },
    readPluginSkills,
    skillRules: { ...organization,
      listSkills: (signal, skillIds) => runWithServerHttpBaseUrl(folderBaseUrl, async () => {
        folderStore.assertCurrent(); signal?.throwIfAborted();
        const skills = await readSkillLibraryCatalog({ ...accountArtifactStore, readPluginSkills }, signal, skillIds);
        folderStore.assertCurrent(); signal?.throwIfAborted();
        return skills;
      }),
      ruleWriteContext: () => ({ nowMs: Date.now(), newId: randomUUID }),
    },
    executionRunHostActionApprovalsCreate: async ({ request }) => {
      const artifactId = randomUUID();
      const res = await accountArtifactStore.create({ artifactId,
        header: buildExecutionRunHostActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) });
      return { artifactId: res.artifactId };
    },
    executionRunHostActionApprovalsGet: async ({ artifactId }) => {
      const artifact = await accountArtifactStore.read(artifactId);
      if (!artifact) return null;
      const header = artifact.header;
      const parsed = readExecutionRunHostActionApprovalArtifact(header, artifact.body);
      if (!parsed) return null;
      return parsed;
    },
    executionRunHostActionApprovalsUpdate: async ({ artifactId, request }) => {
      const artifact = await accountArtifactStore.read(artifactId);
      if (!artifact) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      const existingHeader = artifact.header;
      const existing = readExecutionRunHostActionApprovalArtifact(existingHeader, artifact.body);
      if (!existing || !executionRunHostActionApprovalSubjectsEqual(existing, request)) {
        return { ok: false, errorCode: 'subject_mismatch', error: 'execution_run_host_action_approval_subject_mismatch' };
      }
      if (executionRunHostActionApprovalRequestsEqual(existing, request)) return { ok: true };
      if (existing.status !== 'open'
        || (request.status !== 'approved' && request.status !== 'rejected' && request.status !== 'canceled')
        || request.updatedAtMs < existing.updatedAtMs) {
        return { ok: false, errorCode: 'invalid_transition', error: 'execution_run_host_action_approval_invalid_transition' };
      }
      const updated = await accountArtifactStore.update({ artifactId, expectedRevision: artifact.revision,
        header: buildExecutionRunHostActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) });
      return updated.ok ? { ok: true } : updated;
    },
    targetActionApprovalsCreate: async ({ request }) => {
      const artifactId = randomUUID();
      const res = await accountArtifactStore.create({ artifactId,
        header: buildTargetActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) });
      return { artifactId: res.artifactId };
    },
    targetActionApprovalsGet: async ({ artifactId }) => {
      const artifact = await accountArtifactStore.read(artifactId);
      if (!artifact) return null;
      const header = artifact.header;
      const parsed = readTargetActionApprovalArtifact(header, artifact.body);
      if (!parsed) return null;
      return parsed;
    },
    targetActionApprovalsUpdate: async ({ artifactId, request }) => {
      const artifact = await accountArtifactStore.read(artifactId);
      if (!artifact) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      const existingHeader = artifact.header;
      const existingRequest = readTargetActionApprovalArtifact(existingHeader, artifact.body);
      if (!existingRequest || !targetActionApprovalSubjectsEqual(existingRequest, request)) {
        return { ok: false, errorCode: 'subject_mismatch', error: 'target_action_approval_subject_mismatch' };
      }
      if (targetActionApprovalRequestsEqual(existingRequest, request)) {
        if (existingRequest.status === 'executing') {
          return { ok: false, errorCode: 'invalid_transition', error: 'target_action_approval_invalid_transition' };
        }
        return { ok: true };
      }
      const isOpenDecision = existingRequest.status === 'open'
        && (request.status === 'approved' || request.status === 'rejected' || request.status === 'canceled');
      const isApprovedExecution = existingRequest.status === 'approved'
        && request.status === 'executing'
        && request.decision?.kind === 'approve'
        && request.execution === undefined;
      const isExecutingTerminal = existingRequest.status === 'executing'
        && (request.status === 'executed' || request.status === 'failed')
        && request.decision?.kind === 'approve'
        && request.execution !== undefined;
      if ((!isOpenDecision && !isApprovedExecution && !isExecutingTerminal)
        || request.updatedAtMs < existingRequest.updatedAtMs) {
        return { ok: false, errorCode: 'invalid_transition', error: 'target_action_approval_invalid_transition' };
      }
      const updated = await accountArtifactStore.update({ artifactId, expectedRevision: artifact.revision,
        header: buildTargetActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) });
      return updated.ok ? { ok: true } : updated;
    },
    approvalsList: async ({ status, limit, serverId }) => {
      const items: ApprovalQueueListItemV1[] = [];
      const normalizedServerId = typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : null;
      const maxItems = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 32;
      let cursor: string | undefined;
      do {
        const page = await accountArtifactStore.list({ limit: maxItems, includeBody: true, ...(cursor ? { cursor } : {}) });
        for (const artifact of page.items) {
          if (items.length >= maxItems) break;
          const header = artifact.header;
          if (!header || (header.kind !== APPROVAL_ARTIFACT_KINDS_V1.builtIn
            && header.kind !== APPROVAL_ARTIFACT_KINDS_V1.targetAction)) continue;
          // The finite page already carries a matching header/body revision.
          // Only an omitted or unreadable body needs the individual read path.
          const hydrated = typeof artifact.body === 'string' ? artifact : await accountArtifactStore.read(artifact.artifactId);
          if (!hydrated?.body) continue;
          const parsed = approvalArtifactBodyMatchesHeaderV1(hydrated.header, hydrated.body);
          if (!parsed || parsed.family === 'execution_run_host_action') continue;
          const request = parsed.request;
          if (typeof status === 'string' && request.status !== status) continue;
          const headerServerId = normalizeArtifactServerId(hydrated.header.serverId);
          // V1 has no body-authoritative stable Home identity. Preserve its
          // released profile-scoped history behavior; V2 is Account-scoped and
          // validates creator profile plus Home from its strict body.
          if (parsed.family === 'built_in' && parsed.request.v === 1
            && !approvalArtifactMatchesServerScope(hydrated.header, normalizedServerId)) continue;

          const actionId = parsed.family === 'target_action' ? 'action.invoke' : parseApprovalActionId(parsed.request.actionId);
          const summary = request.summary;
          const approvalStatus = parseApprovalStatus(request.status);
          if (!actionId || !summary || !approvalStatus) continue;

          items.push({
            artifactId: artifact.artifactId,
            status: approvalStatus,
            actionId,
            summary,
            ...(typeof hydrated.header.sessionId === 'string' && hydrated.header.sessionId.trim().length > 0 ? { sessionId: hydrated.header.sessionId.trim() } : {}),
            ...(headerServerId ? { serverId: headerServerId } : {}),
            updatedAtMs: Number.isFinite(hydrated.updatedAt) ? hydrated.updatedAt : 0,
          });
        }
        cursor = items.length < maxItems ? page.nextCursor : undefined;
      } while (cursor);

      return {
        items,
        queryPlan: {
          kind: 'approval_artifact_header_scan',
          backingStore: 'ArtifactStore',
          boundedBy: items.length >= maxItems ? 'requested matching approval count' : 'ArtifactStore source exhaustion',
          serverLimit: maxItems,
          hydratedTranscripts: false,
        },
      };
    },

    approvalsCreate: async ({ request, serverId }) => {
      const pendingReview = request.v === 2 && request.actionId === 'plugins.install'
        ? readPluginInstallApprovalPendingReview(request.preview) : null;
      let artifactId = pendingReview?.pendingChangeId ?? randomUUID();

      const header = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: serverId });
      if (request.v === 2 && typeof serverId === 'string' && serverId.trim() !== request.executionOriginV1.serverId) {
        throw new Error('approval_request_server_target_mismatch');
      }

      const inspectPendingReviewArtifact = async (): Promise<'absent' | 'active' | 'terminal'> => {
        const artifact = await accountArtifactStore.read(artifactId);
        if (!artifact) return 'absent';
        const existing = readBuiltInApprovalArtifact(artifact.header, artifact.body);
        if (artifact.access !== 'owner' || existing?.v !== 2 || request.v !== 2
          || existing.actionId !== 'plugins.install'
          || !sameStrictJsonValue(readPluginInstallApprovalPendingReview(existing.preview), pendingReview)
          || existing.executionOriginV1.accountId !== request.executionOriginV1.accountId
          || !existing.executionOriginV1.machineId
          || existing.executionOriginV1.machineId !== request.executionOriginV1.machineId
          || existing.executionOriginV1.serverIdentityId !== request.executionOriginV1.serverIdentityId
          || (!existing.executionOriginV1.serverIdentityId
            && existing.executionOriginV1.serverId !== request.executionOriginV1.serverId)) {
          throw Object.assign(new Error('approval_request_subject_mismatch'), { code: 'subject_mismatch' });
        }
        return existing.status === 'open' || existing.status === 'approved' || existing.status === 'executing'
          ? 'active'
          : 'terminal';
      };
      if (!pendingReview) {
        const res = await accountArtifactStore.create({ artifactId, header, body: JSON.stringify(request) });
        return { artifactId: res.artifactId };
      }
      // Each retained daemon subject owns a deterministic Artifact chain. A
      // terminal row remains immutable history; every observer follows the
      // same successor id and therefore rejoins the one active lifecycle.
      while (true) {
        const existingState = await inspectPendingReviewArtifact();
        if (existingState === 'active') return { artifactId };
        if (existingState === 'terminal') {
          artifactId = derivePluginInstallApprovalSuccessorArtifactId(artifactId);
          continue;
        }
        try {
          const res = await accountArtifactStore.create({ artifactId, header, body: JSON.stringify(request) });
          return { artifactId: res.artifactId };
        } catch (error) {
          if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'conflict') continue;
          throw error;
        }
      }
    },

    approvalsGet: async ({ artifactId, serverId }) => {
      const artifact = await accountArtifactStore.read(artifactId);
      if (!artifact) return null;
      const header = artifact.header;
      if (!header) return null;
      const body = artifact.body;
      if (!body) return null;

      const parsed = approvalArtifactBodyMatchesHeaderV1(header, body);
      if (parsed?.family === 'built_in' && parsed.request.v === 1
        && !approvalArtifactMatchesServerScope(header, normalizeArtifactServerId(serverId))) {
        return null;
      }
      return parsed && parsed.family !== 'execution_run_host_action' ? parsed.request : null;
    },

    approvalsUpdate: async ({ artifactId, request, serverId }) => {
      const artifact = await accountArtifactStore.read(artifactId);
      if (!artifact) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      const existingHeader = artifact.header;
      if (!existingHeader) {
        return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      }

      const existingBody = artifact.body;
      const existing = readBuiltInApprovalArtifact(existingHeader, existingBody);
      if (existing?.v === 1 && !approvalArtifactMatchesServerScope(existingHeader, normalizeArtifactServerId(serverId))) {
        return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      }
      if (!existing) {
        return {
          ok: false,
          errorCode: 'subject_mismatch',
          error: 'approval_request_subject_mismatch',
        };
      }
      // The Protocol subject/transition owner is shared with the UI adapter:
      // immutable subject (settlements may only apply the Action's declared
      // input projection), the lifecycle edges, and the refusal of a repeated
      // `executing` claim. This store only commits against the revision it read.
      const transition = decideApprovalRequestTransition(existing, request);
      if (!transition.ok) return transition;
      if (!transition.changed) return { ok: true };

      // V1's Home marker belongs to retained history, not replay authority or
      // the deciding caller's routing hint. Keep this validated CAS basis's index.
      const header = buildApprovalRequestArtifactHeaderV1(request, {
        legacyServerId: existing.v === 1 ? normalizeArtifactServerId(existingHeader.serverId) : null,
      });
      const updated = await accountArtifactStore.update({ artifactId, expectedRevision: artifact.revision,
        header, body: JSON.stringify(request) });

      if (updated.ok) return { ok: true };
      return { ok: false, errorCode: updated.errorCode, error: updated.error };
    },
  };
}
