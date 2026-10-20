import { randomUUID } from 'node:crypto';

import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { normalizeCodexBackendMode } from '@happier-dev/protocol/sessions/metadata/overrides';
import { projectRuntimeDescriptorV1ForPredecessor } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { SessionHandoffAbortRequestSchema, SessionHandoffCommitRequestSchema, SessionHandoffPrepareTargetResponseSchema, SessionHandoffStartResponseSchema } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { z } from 'zod/mini';
import { z as zMini } from 'zod/mini';

import type { RpcHandlerManager } from '../../rpc/RpcHandlerManager';
import type {
  SessionHandoffPrepareTargetJobRecordV2,
  SessionHandoffPrepareTargetJobStore,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import type {
  SpawnSessionOptions,
  SpawnSessionResult,
} from '../../../session/shared/spawnSessionContract';
import { hasUnsupportedWorkspaceAction, workspaceSyncUpdateRequired } from './workspaceSyncGuard';

type JsonRecord = Record<string, unknown>;

// Immutable request vectors from cli-v0.2.11. These schemas deliberately live
// at the released compatibility seam: current Protocol handoff schemas are
// additive/passthrough and therefore cannot freeze the unversioned methods.
const RELEASED_HANDOFF_ID_MAX = 256;
const RELEASED_MACHINE_ID_MAX = 256;
const RELEASED_PATH_MAX = 4096;
const RELEASED_ENDPOINT_URL_MAX = 2048;
const RELEASED_ENDPOINT_TOKEN_MAX = 2048;
const RELEASED_ENDPOINTS_MAX = 20;
const RELEASED_TRANSFER_ID_MAX = 512;
const RELEASED_MANIFEST_HASH_MAX = 256;
const RELEASED_INCLUDE_GLOBS_MAX = 128;
const RELEASED_METADATA_KEYS_MAX = 50;
const RELEASED_METADATA_BYTES_MAX = 32 * 1024;

const ReleasedEndpointCandidateSchema = z.strictObject({
  kind: z.enum(['tcp', 'http', 'https']),
  url: z.string().check(z.minLength(1), z.maxLength(RELEASED_ENDPOINT_URL_MAX)),
  authorizationToken: z.optional(z.string().check(z.minLength(1), z.maxLength(RELEASED_ENDPOINT_TOKEN_MAX))),
  expiresAt: z.number().check(z.int(), z.nonnegative()),
}).check(z.superRefine((value, context) => {
  try {
    if (new URL(value.url).protocol !== `${value.kind}:`) {
      context.addIssue({
        code: "custom",
        path: ['url'],
        message: `Transfer endpoint candidate URL must use the ${value.kind}: scheme`,
      });
    }
  } catch {
    context.addIssue({
      code: "custom",
      path: ['url'],
      message: 'Transfer endpoint candidates need an absolute URL',
    });
  }
}));

const ReleasedWorkspaceTransferSchema = z.strictObject({
  enabled: z.boolean(),
  strategy: z._default(z.enum(['transfer_snapshot', 'sync_changes']), 'transfer_snapshot'),
  conflictPolicy: z.enum(['create_sibling_copy', 'replace_existing']),
  includeIgnoredMode: z._default(z.enum(['exclude', 'include_selected']), 'exclude'),
  ignoredIncludeGlobs: z._default(z.readonly(z.array(z.string().check(z.minLength(1), z.maxLength(512))).check(z.maxLength(RELEASED_INCLUDE_GLOBS_MAX))), () => []),
}).check(z.superRefine((value, context) => {
  if (value.strategy === 'sync_changes' && value.conflictPolicy === 'create_sibling_copy') {
    context.addIssue({
      code: "custom",
      path: ['conflictPolicy'],
      message: 'conflictPolicy=create_sibling_copy is not supported for workspaceTransfer.strategy=sync_changes',
    });
  }
}));

const ReleasedBundlePublicationSchema = z.strictObject({
  transferId: z.string().check(z.minLength(1), z.maxLength(RELEASED_TRANSFER_ID_MAX)),
  sizeBytes: z.number().check(z.int(), z.minimum(0)),
  manifestHash: z.string().check(z.minLength(1), z.maxLength(RELEASED_MANIFEST_HASH_MAX)),
  endpointCandidates: z.optional(z.readonly(z.array(ReleasedEndpointCandidateSchema).check(z.maxLength(RELEASED_ENDPOINTS_MAX)))),
});

const ReleasedManifestPublicationSchema = z.strictObject({
  transferId: z.string().check(z.minLength(1), z.maxLength(RELEASED_TRANSFER_ID_MAX)),
  endpointCandidates: z.optional(z.readonly(z.array(ReleasedEndpointCandidateSchema).check(z.maxLength(RELEASED_ENDPOINTS_MAX)))),
});

const ReleasedMetadataV2Schema = z.strictObject({
  providerBundleTransferPublication: z.optional(ReleasedBundlePublicationSchema),
  workspaceReplicationSourceRootPath: z.optional(z.string().check(z.minLength(1), z.maxLength(RELEASED_PATH_MAX))),
  workspaceReplicationHandoffBackTargetRootPath: z.optional(z.string().check(z.minLength(1), z.maxLength(RELEASED_PATH_MAX))),
  workspaceReplicationManifestTransferPublication: z.optional(ReleasedManifestPublicationSchema),
  workspaceReplicationSourceControllerMetadata: z.optional(z.record(z.string().check(z.minLength(1), z.maxLength(128)), z.unknown()).check(z.superRefine((value, context) => {
      if (Object.keys(value).length > RELEASED_METADATA_KEYS_MAX) {
        context.addIssue({ code: "custom", message: 'workspaceReplicationSourceControllerMetadata is too large' });
      }
      let encoded: string;
      try {
        encoded = JSON.stringify(value);
      } catch {
        context.addIssue({ code: "custom", message: 'workspaceReplicationSourceControllerMetadata is too large' });
        return;
      }
      if (new TextEncoder().encode(encoded).length > RELEASED_METADATA_BYTES_MAX) {
        context.addIssue({ code: "custom", message: 'workspaceReplicationSourceControllerMetadata is too large' });
      }
    }))),
});

// Released shape provenance: immutable tag cli-v0.2.11,
// packages/protocol/src/sessionControl/handoff/handoffSchemas.ts. The released
// delegated start path supplies optional requestId (max 2000),
// targetSessionStorageMode, and targetPath alongside workspaceTransfer. They
// are declared here so a real released request still parses and the retired
// workspaceTransfer field reaches the start handler's typed
// workspace_sync_update_required guard instead of being rejected as
// invalid_request before that guard can run.
const ReleasedStartRequestSchema = z.strictObject({
  requestId: z.optional(z.string().check(z.minLength(1), z.maxLength(2000))),
  sessionId: z.string().check(z.minLength(1), z.maxLength(RELEASED_HANDOFF_ID_MAX)),
  sourceMachineId: z.string().check(z.minLength(1), z.maxLength(RELEASED_MACHINE_ID_MAX)),
  targetMachineId: z.string().check(z.minLength(1), z.maxLength(RELEASED_MACHINE_ID_MAX)),
  sessionStorageMode: z.enum(['direct', 'persisted']),
  targetSessionStorageMode: z.optional(z.enum(['direct', 'persisted'])),
  targetPath: z.optional(z.string().check(z.minLength(1), z.maxLength(RELEASED_PATH_MAX))),
  preferredTransportStrategies: z.readonly(z.array(z.enum(['direct_peer', 'server_routed_stream'])).check(z.minLength(1), z.maxLength(4))),
  negotiatedTransportStrategy: z.optional(z.enum(['direct_peer', 'server_routed_stream'])),
  workspaceTransfer: z.optional(ReleasedWorkspaceTransferSchema),
});

const ReleasedPrepareTargetRequestSchema = z.strictObject({
  handoffId: z.string().check(z.minLength(1), z.maxLength(RELEASED_HANDOFF_ID_MAX)),
  sourceMachineId: z.string().check(z.minLength(1), z.maxLength(RELEASED_MACHINE_ID_MAX)),
  targetMachineId: z.string().check(z.minLength(1), z.maxLength(RELEASED_MACHINE_ID_MAX)),
  negotiatedTransportStrategy: z.enum(['direct_peer', 'server_routed_stream']),
  allowServerRoutedFallback: z.optional(z.boolean()),
  sourceSessionStorageMode: z.enum(['direct', 'persisted']),
  targetSessionStorageMode: z.optional(z.enum(['direct', 'persisted'])),
  targetPath: z.string().check(z.minLength(1), z.maxLength(RELEASED_PATH_MAX)),
  endpointCandidates: z._default(z.readonly(z.array(ReleasedEndpointCandidateSchema).check(z.maxLength(RELEASED_ENDPOINTS_MAX))), () => []),
  handoffMetadataV2: z.optional(ReleasedMetadataV2Schema),
  workspaceTransfer: z.optional(ReleasedWorkspaceTransferSchema),
});

const ReleasedResultGetRequestSchema = z.strictObject({
  handoffId: z.string().check(z.minLength(1), z.maxLength(RELEASED_HANDOFF_ID_MAX)),
});

const ReleasedCommitRequestSchema = z.strictObject({
  handoffId: z.string().check(z.minLength(1), z.maxLength(RELEASED_HANDOFF_ID_MAX)),
  mode: z.optional(z.enum(['target', 'source_cleanup'])),
  workspaceReplicationReverseSourceRootPath: z.optional(z.string().check(z.minLength(1), z.maxLength(RELEASED_PATH_MAX))),
  workspaceReplicationReverseTargetRootPath: z.optional(z.string().check(z.minLength(1), z.maxLength(RELEASED_PATH_MAX))),
});

const ReleasedAbortRequestSchema = z.strictObject({
  handoffId: z.string().check(z.minLength(1), z.maxLength(RELEASED_HANDOFF_ID_MAX)),
  reason: z.string().check(z.minLength(1), z.maxLength(1024)),
});

const RELEASED_REQUEST_SCHEMA_BY_METHOD = Object.freeze({
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_START]: ReleasedStartRequestSchema,
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET]: ReleasedPrepareTargetRequestSchema,
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET]: ReleasedResultGetRequestSchema,
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT]: ReleasedCommitRequestSchema,
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT]: ReleasedAbortRequestSchema,
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET]: ReleasedResultGetRequestSchema,
} satisfies Readonly<Record<string, z.ZodMiniType>>);

export function projectReleasedSessionHandoffRequestForMethod(
  method: string,
  input: unknown,
): Readonly<
  | { accepted: true; input: unknown }
  | { accepted: false; response: Readonly<{ ok: false; errorCode: 'invalid_request' }> }
> {
  const schema = RELEASED_REQUEST_SCHEMA_BY_METHOD[method as keyof typeof RELEASED_REQUEST_SCHEMA_BY_METHOD];
  if (!schema) return { accepted: true, input };
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { accepted: true, input: parsed.data }
    : { accepted: false, response: { ok: false, errorCode: 'invalid_request' } };
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function projectEndpointCandidate(value: unknown): unknown {
  const candidate = asRecord(value);
  if (!candidate) return value;
  return {
    kind: candidate.kind,
    url: candidate.url,
    ...(candidate.authorizationToken !== undefined
      ? { authorizationToken: candidate.authorizationToken }
      : {}),
    expiresAt: candidate.expiresAt,
  };
}

function projectProgress(value: unknown): unknown {
  const progress = asRecord(value);
  if (!progress) return value;
  const projectCounts = (raw: unknown): unknown => {
    const counts = asRecord(raw);
    if (!counts) return raw;
    return {
      ...(counts.files !== undefined ? { files: counts.files } : {}),
      ...(counts.bytes !== undefined ? { bytes: counts.bytes } : {}),
    };
  };
  const planned = asRecord(progress.planned);
  const transferred = asRecord(progress.transferred);
  const current = asRecord(progress.current);
  return {
    updatedAtMs: progress.updatedAtMs,
    checkpoint: progress.checkpoint,
    planned: {
      ...(planned?.totalFiles !== undefined ? { totalFiles: planned.totalFiles } : {}),
      ...(planned?.totalBytes !== undefined ? { totalBytes: planned.totalBytes } : {}),
      ...(planned?.added !== undefined ? { added: planned.added } : {}),
      ...(planned?.changed !== undefined ? { changed: planned.changed } : {}),
      ...(planned?.removed !== undefined ? { removed: planned.removed } : {}),
    },
    transferred: {
      ...(transferred?.files !== undefined ? { files: transferred.files } : {}),
      ...(transferred?.bytes !== undefined ? { bytes: transferred.bytes } : {}),
      ...(transferred?.blobs !== undefined ? { blobs: transferred.blobs } : {}),
    },
    ...(progress.applied !== undefined ? { applied: projectCounts(progress.applied) } : {}),
    ...(progress.remaining !== undefined ? { remaining: projectCounts(progress.remaining) } : {}),
    ...(current
      ? {
          current: {
            ...(current.relativePath !== undefined ? { relativePath: current.relativePath } : {}),
            ...(current.digest !== undefined ? { digest: current.digest } : {}),
            ...(current.phaseDetail !== undefined ? { phaseDetail: current.phaseDetail } : {}),
          },
        }
      : {}),
    resumable: progress.resumable,
    ...(progress.warnings !== undefined ? { warnings: progress.warnings } : {}),
  };
}

function projectStatus(value: unknown): unknown {
  const status = asRecord(value);
  if (!status) return value;
  const statusCode =
    status.status === 'awaiting_user_resume'
    || status.status === 'reconciliation_required'
      ? 'awaiting_recovery'
      : status.status;
  const transportStrategy =
    status.transportStrategy === 'direct_peer'
    || status.transportStrategy === 'server_routed_stream'
    || status.transportStrategy === null
      ? status.transportStrategy
      : undefined;
  const preflight = asRecord(status.workspacePreflightSummary);
  return {
    handoffId: status.handoffId,
    status: statusCode,
    phase: status.phase,
    ...(status.jobId !== undefined ? { jobId: status.jobId } : {}),
    ...(status.progress !== undefined ? { progress: projectProgress(status.progress) } : {}),
    ...(preflight
      ? {
          workspacePreflightSummary: {
            addedPathsCount: preflight.addedPathsCount,
            changedPathsCount: preflight.changedPathsCount,
            removedPathsCount: preflight.removedPathsCount,
            ...(preflight.totalBytes !== undefined ? { totalBytes: preflight.totalBytes } : {}),
          },
        }
      : {}),
    ...(transportStrategy !== undefined ? { transportStrategy } : {}),
    recoveryActions: status.recoveryActions,
  };
}

function projectPublication(value: unknown): unknown {
  const publication = asRecord(value);
  if (!publication) return value;
  return {
    transferId: publication.transferId,
    sizeBytes: publication.sizeBytes,
    manifestHash: publication.manifestHash,
    ...(Array.isArray(publication.endpointCandidates)
      ? { endpointCandidates: publication.endpointCandidates.map(projectEndpointCandidate) }
      : {}),
  };
}

function projectMetadata(value: unknown): unknown {
  const metadata = asRecord(value);
  if (!metadata) return value;
  const agentPublication =
    metadata.agentBundleTransferPublication
    ?? metadata.providerBundleTransferPublication;
  return {
    ...(agentPublication !== undefined
      ? {
          providerBundleTransferPublication: projectPublication(agentPublication),
        }
      : {}),
  };
}

function projectResume(value: unknown, runtimeDescriptorV1?: unknown): unknown {
  const resume = asRecord(value);
  if (!resume) return value;
  const descriptor = asRecord(runtimeDescriptorV1);
  const descriptorAgent = asRecord(descriptor?.agent);
  const codexBackendMode = normalizeCodexBackendMode(
    resume.codexBackendMode
      ?? (descriptor?.agentId === 'codex' ? descriptorAgent?.backendMode : undefined),
  ) ?? undefined;
  return {
    directory: resume.directory,
    agent: resume.agent,
    resume: resume.resume,
    ...(resume.environmentVariables !== undefined
      ? { environmentVariables: resume.environmentVariables }
      : {}),
    transcriptStorage: resume.transcriptStorage,
    approvedNewDirectoryCreation: resume.approvedNewDirectoryCreation,
    ...(codexBackendMode ? { codexBackendMode } : {}),
  };
}

/**
 * Strict egress projection for preview/stable predecessor readers.
 *
 * Provenance: remote-dev 1b32cdc6 and immutable preview 4913c1e. The adapter may be removed only
 * after those deployed/rollback readers and V2 callers are unreachable.
 */
export function projectSessionHandoffStartResponseForPredecessor(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const response = SessionHandoffStartResponseSchema.parse(value);
  return {
    handoffId: response.handoffId,
    status: projectStatus(response.status),
    endpointCandidates: response.endpointCandidates.map(projectEndpointCandidate),
    targetPath: response.targetPath,
    ...(response.handoffMetadataV2
      ? { handoffMetadataV2: projectMetadata(response.handoffMetadataV2) }
      : {}),
  };
}

export function projectSessionHandoffPrepareTargetResponseForPredecessor(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const response = SessionHandoffPrepareTargetResponseSchema.parse(value);
  return {
    handoffId: response.handoffId,
    status: projectStatus(response.status),
    ...(response.remoteSessionId !== undefined
      ? { remoteSessionId: response.remoteSessionId }
      : {}),
    ...(response.directSource !== undefined ? { directSource: response.directSource } : {}),
    ...(response.runtimeDescriptorV1 !== undefined
      ? {
          agentRuntimeDescriptorV1:
            projectRuntimeDescriptorV1ForPredecessor(response.runtimeDescriptorV1),
        }
      : {}),
    ...(response.resume !== undefined
      ? { resume: projectResume(response.resume, response.runtimeDescriptorV1) }
      : {}),
  };
}

function projectStatusResponseForPredecessor(value: unknown): unknown {
  const response = asRecord(value);
  if (response?.ok === false || typeof response?.errorCode === 'string') {
    return value;
  }
  if (!response || typeof response.handoffId !== 'string' || !asRecord(response.status)) {
    return value;
  }
  return {
    handoffId: response.handoffId,
    status: projectStatus(response.status),
    ...(response.targetCleanup !== undefined
      ? { targetCleanup: response.targetCleanup }
      : {}),
  };
}

/**
 * The six immutable released RPC spellings are the compatibility
 * discriminator. Current V3 methods never enter this projection.
 */
export function projectReleasedSessionHandoffResponseForMethod(
  method: string,
  value: unknown,
): unknown {
  if (method === RPC_METHODS.DAEMON_SESSION_HANDOFF_START) {
    return projectSessionHandoffResponseForPredecessor('start', value);
  }
  if (
    method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET
    || method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET
  ) {
    return projectSessionHandoffResponseForPredecessor('prepare', value);
  }
  if (
    method === RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT
    || method === RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT
    || method === RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET
  ) {
    return projectStatusResponseForPredecessor(value);
  }
  return value;
}

export function projectSessionHandoffResponseForPredecessor(
  kind: 'start' | 'prepare' | 'status',
  value: unknown,
): unknown {
  if (kind === 'start') {
    const parsed = SessionHandoffStartResponseSchema.safeParse(value);
    return parsed.success
      ? projectSessionHandoffStartResponseForPredecessor(parsed.data)
      : value;
  }
  if (kind === 'prepare') {
    const parsed = SessionHandoffPrepareTargetResponseSchema.safeParse(value);
    return parsed.success
      ? projectSessionHandoffPrepareTargetResponseForPredecessor(parsed.data)
      : value;
  }
  return projectStatusResponseForPredecessor(value);
}

const PredecessorPrepareTargetRequestV2Schema = z.strictObject({
  handoffId: z.string().check(z.minLength(1), z.maxLength(256)),
  sessionId: z.string().check(z.minLength(1), z.maxLength(256)),
  sourceMachineId: z.string().check(z.minLength(1), z.maxLength(256)),
  targetMachineId: z.string().check(z.minLength(1), z.maxLength(256)),
  negotiatedTransportStrategy: z.unknown(),
  allowServerRoutedFallback: z.optional(z.boolean()),
  sourceSessionStorageMode: z.unknown(),
  targetSessionStorageMode: z.optional(z.unknown()),
  targetPath: z.string().check(z.minLength(1), z.maxLength(4096)),
  endpointCandidates: z._default(z.array(z.unknown()).check(z.maxLength(20)), []),
  handoffMetadataV2: z.optional(z.unknown()),
  workspaceTransfer: z.optional(z.unknown()),
});

const PredecessorResultGetRequestV2Schema = z.strictObject({
  handoffId: z.string().check(z.minLength(1), z.maxLength(256)),
  sessionId: z.string().check(z.minLength(1), z.maxLength(256)),
});

const PredecessorTargetResumeRequestV2Schema = z.strictObject({
  handoffId: z.string().check(z.minLength(1), z.maxLength(256)),
  sessionId: z.string().check(z.minLength(1), z.maxLength(256)),
  attemptId: z.string().check(z.minLength(1), z.maxLength(256)),
  connectedServices: z.optional(ConnectedServiceBindingsV1Schema),
});

const PredecessorTargetConfirmRequestV2Schema = z.strictObject({
  handoffId: z.string().check(z.minLength(1), z.maxLength(256)),
  sessionId: z.string().check(z.minLength(1), z.maxLength(256)),
  attemptId: z.string().check(z.minLength(1), z.maxLength(256)),
});

const PredecessorCommitRequestV2Schema = zMini.extend(SessionHandoffCommitRequestSchema, {
  sessionId: z.string().check(z.minLength(1), z.maxLength(256)),
  attemptId: z.string().check(z.minLength(1), z.maxLength(256)),
  workspaceReplicationReverseSourceRootPath: z.optional(z.string().check(z.minLength(1), z.maxLength(RELEASED_PATH_MAX))),
  workspaceReplicationReverseTargetRootPath: z.optional(z.string().check(z.minLength(1), z.maxLength(RELEASED_PATH_MAX))),
});

const PredecessorAbortRequestV2Schema = zMini.extend(SessionHandoffAbortRequestSchema, {
  sessionId: z.string().check(z.minLength(1), z.maxLength(256)),
});

function invalidRequest() {
  return { ok: false, errorCode: 'invalid_request' } as const;
}

function isExactPreparedTarget(
  job: SessionHandoffPrepareTargetJobRecordV2 | null,
  input: Readonly<{ handoffId: string; sessionId: string }>,
): job is SessionHandoffPrepareTargetJobRecordV2 & Readonly<{
  recordKind: 'prepared_target';
  sessionId: string;
}> {
  return job?.recordKind === 'prepared_target'
    && job.handoffId === input.handoffId
    && job.sessionId === input.sessionId;
}

/**
 * Register the semantic RPC adapter for the exact remote-dev 1b32cdc6 V2 handoff caller.
 *
 * This adapter delegates preparation, result lookup, commit, and abort to the current canonical
 * owners. Target resume remains fail-closed until canonical spawn exposes equivalent acceptance
 * evidence. The adapter owns no parallel job store or orchestration lifecycle.
 */
export function registerSessionHandoffPredecessorCompatibilityHandlers(input: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  prepareTarget: (raw: unknown) => Promise<unknown>;
  prepareTargetResultGet: (raw: unknown) => Promise<unknown>;
  commit: (raw: unknown) => Promise<unknown>;
  abort: (raw: unknown) => Promise<unknown>;
  spawnSessionForHandoff?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSessionForHandoff?: (
    sessionId: string,
  ) => Promise<'stopped' | 'already_inactive' | 'failed'>;
  now?: () => number;
  createOperationId?: (kind: 'commit' | 'abort') => string;
}>): void {
  const now = input.now ?? Date.now;
  const createOperationId = input.createOperationId
    ?? ((kind: 'commit' | 'abort') => `${kind}_${randomUUID()}`);

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
    async (raw: unknown) => {
      if (!asRecord(raw) || Object.keys(raw as JsonRecord).length !== 0) return invalidRequest();
      return {
        protocolVersion: 2,
        // The current canonical spawn result exposes session identity but not the predecessor's
        // pre-launch acceptance hook or runner-ownership disposition. Function presence cannot
        // safely advertise atomic resume or cleanup authority.
        atomicTargetResume: false,
        targetCleanup: false,
      } as const;
    },
  );

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2,
    async (raw: unknown) => {
      const parsed = PredecessorPrepareTargetRequestV2Schema.safeParse(raw);
      if (!parsed.success) return invalidRequest();
      if (hasUnsupportedWorkspaceAction(parsed.data)) return workspaceSyncUpdateRequired();
      const { sessionId, ...canonicalRequest } = parsed.data;
      const result = await input.prepareTarget(canonicalRequest);
      const finalResponse = SessionHandoffPrepareTargetResponseSchema.safeParse(result);
      if (finalResponse.success && finalResponse.data.resume) {
        const job = await input.prepareJobStore.findByHandoffId(parsed.data.handoffId);
        if (!job) return { ok: false, errorCode: 'not_found' } as const;
        await input.prepareJobStore.upgradeReadyV1ToPreparedV2({
          jobId: job.jobId,
          sessionId,
        });
      }
      return projectSessionHandoffResponseForPredecessor('prepare', result);
    },
  );

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2,
    async (raw: unknown) => {
      const parsed = PredecessorResultGetRequestV2Schema.safeParse(raw);
      if (!parsed.success) return invalidRequest();
      const result = await input.prepareTargetResultGet({
        handoffId: parsed.data.handoffId,
      });
      const finalResponse = SessionHandoffPrepareTargetResponseSchema.safeParse(result);
      if (!finalResponse.success) return result;
      const job = await input.prepareJobStore.findByHandoffId(parsed.data.handoffId);
      if (!job) return { ok: false, errorCode: 'not_found' } as const;
      try {
        await input.prepareJobStore.upgradeReadyV1ToPreparedV2({
          jobId: job.jobId,
          sessionId: parsed.data.sessionId,
        });
      } catch {
        return { ok: false, errorCode: 'invalid_persisted_job' } as const;
      }
      return projectSessionHandoffResponseForPredecessor('prepare', result);
    },
  );

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2,
    async (raw: unknown) => {
      const parsed = PredecessorTargetResumeRequestV2Schema.safeParse(raw);
      if (!parsed.success) return invalidRequest();
      return { ok: false, errorCode: 'unsupported' } as const;
    },
  );

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2,
    async (raw: unknown) => {
      const parsed = PredecessorTargetConfirmRequestV2Schema.safeParse(raw);
      if (!parsed.success) return invalidRequest();
      const found = await input.prepareJobStore.findByHandoffId(parsed.data.handoffId);
      const job = found?.schemaVersion === 2 ? found : null;
      if (!isExactPreparedTarget(job, parsed.data)) {
        return { ok: false, errorCode: 'invalid_persisted_job' } as const;
      }
      if (
        job.terminal.status === 'open'
        && job.resume.status === 'confirmed'
        && job.resume.attemptId === parsed.data.attemptId
      ) {
        return projectStatus(job.status);
      }
      const confirmedAtMs = now();
      const transitioned = await input.prepareJobStore.transitionPredecessorV2(
        job.jobId,
        (current) => {
          if (
            current.recordKind !== 'prepared_target'
            || current.terminal.status !== 'open'
            || current.resume.status !== 'attempted'
            || current.resume.attemptId !== parsed.data.attemptId
          ) {
            throw new Error('Target confirmation does not match the accepted predecessor attempt');
          }
          return {
            ...current,
            updatedAtMs: confirmedAtMs,
            transitionRevision: current.transitionRevision + 1,
            resume: {
              ...current.resume,
              status: 'confirmed',
              confirmedAtMs,
            },
          };
        },
      );
      return transitioned ? projectStatus(transitioned.status) : { ok: false, errorCode: 'not_found' };
    },
  );

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V2,
    async (raw: unknown) => {
      const parsed = PredecessorCommitRequestV2Schema.safeParse(raw);
      if (!parsed.success || (parsed.data.mode ?? 'target') !== 'target') return invalidRequest();
      if (hasUnsupportedWorkspaceAction(parsed.data)) return workspaceSyncUpdateRequired();
      const found = await input.prepareJobStore.findByHandoffId(parsed.data.handoffId);
      const job = found?.schemaVersion === 2 ? found : null;
      if (!isExactPreparedTarget(job, parsed.data)) {
        return { ok: false, errorCode: 'invalid_persisted_job' } as const;
      }
      if (
        job.terminal.status === 'completed'
        && job.resume.status === 'confirmed'
        && job.resume.attemptId === parsed.data.attemptId
      ) {
        return projectStatusResponseForPredecessor(await input.commit({
          handoffId: parsed.data.handoffId,
          mode: 'target',
        }));
      }
      const committedAtMs = now();
      await input.prepareJobStore.transitionPredecessorV2(job.jobId, (current) => {
        if (
          current.recordKind !== 'prepared_target'
          || current.terminal.status !== 'open'
          || current.resume.status !== 'confirmed'
          || current.resume.attemptId !== parsed.data.attemptId
        ) {
          throw new Error('Target commit requires the exact confirmed predecessor attempt');
        }
        const nextRevision = current.transitionRevision + 1;
        return {
          ...current,
          updatedAtMs: committedAtMs,
          completedAtMs: committedAtMs,
          transitionRevision: nextRevision,
          terminal: {
            status: 'completed',
            operationId: createOperationId('commit'),
            completedRevision: nextRevision,
          },
          status: {
            ...current.status,
            status: 'completed',
            recoveryActions: [],
          },
        };
      });
      return projectStatusResponseForPredecessor(await input.commit({
        handoffId: parsed.data.handoffId,
        mode: 'target',
      }));
    },
  );

  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2,
    async (raw: unknown) => {
      const parsed = PredecessorAbortRequestV2Schema.safeParse(raw);
      if (!parsed.success) return invalidRequest();
      const found = await input.prepareJobStore.findByHandoffId(parsed.data.handoffId);
      const job = found?.schemaVersion === 2 ? found : null;
      if (!isExactPreparedTarget(job, parsed.data)) {
        return { ok: false, errorCode: 'invalid_persisted_job' } as const;
      }
      if (job.terminal.status === 'completed') {
        return projectStatusResponseForPredecessor({
          handoffId: job.handoffId,
          status: job.status,
          targetCleanup: job.targetCleanup,
        });
      }
      if (job.terminal.status === 'aborted') {
        const canonical = await input.abort({
          handoffId: parsed.data.handoffId,
          reason: parsed.data.reason,
        });
        return projectStatusResponseForPredecessor({
          ...(asRecord(canonical) ?? {}),
          handoffId: job.handoffId,
          status: asRecord(canonical)?.status ?? job.status,
          targetCleanup: job.targetCleanup,
        });
      }
      const ambiguousResume = job.resume.status === 'attempted' || job.resume.status === 'confirmed';
      const cleanupAttemptedAtMs = now();
      let cleanupProof: 'stopped' | 'already_inactive' | null = null;
      if (ambiguousResume) {
        try {
          const stopResult = input.stopSessionForHandoff
            ? await input.stopSessionForHandoff(job.sessionId)
            : 'failed';
          if (stopResult !== 'failed') cleanupProof = stopResult;
        } catch {
          cleanupProof = null;
        }
      }
      if (ambiguousResume && cleanupProof === null) {
        const failed = await input.prepareJobStore.transitionPredecessorV2(
          job.jobId,
          (current) => ({
            ...current,
            updatedAtMs: cleanupAttemptedAtMs,
            transitionRevision: current.transitionRevision + 1,
            targetCleanup: {
              status: 'failed',
              reason: 'unreachable',
              attemptedAtMs: cleanupAttemptedAtMs,
            },
            status: {
              ...current.status,
              status: 'awaiting_recovery',
              recoveryActions: ['keep_stopped'],
            },
          }),
        );
        return projectStatusResponseForPredecessor({
          handoffId: job.handoffId,
          status: failed?.status ?? job.status,
          targetCleanup: failed?.recordKind === 'prepared_target'
            ? failed.targetCleanup
            : job.targetCleanup,
        });
      }
      const abortedAtMs = now();
      const operationId = createOperationId('abort');
      const transitioned = await input.prepareJobStore.transitionPredecessorV2(
        job.jobId,
        (current) => {
          if (current.recordKind !== 'prepared_target' || current.terminal.status !== 'open') {
            throw new Error('Target abort requires exact open predecessor ownership');
          }
          const nextRevision = current.transitionRevision + 1;
          const targetCleanup = cleanupProof !== null
            ? {
                status: 'proved_absent' as const,
                proof: cleanupProof,
                provedAtMs: abortedAtMs,
              }
            : current.resume.status === 'preexisting_unowned'
            ? {
                status: 'not_owned' as const,
                reason: 'preexisting_or_adopted' as const,
              }
            : {
                status: 'not_owned' as const,
                reason: 'resume_not_attempted' as const,
              };
          return {
            ...current,
            updatedAtMs: abortedAtMs,
            cancelRequestedAtMs: current.cancelRequestedAtMs ?? abortedAtMs,
            abortedAtMs,
            transitionRevision: nextRevision,
            terminal: {
              status: 'aborted',
              operationId,
              completedRevision: nextRevision,
            },
            targetCleanup,
            status: {
              ...current.status,
              status: 'aborted',
              recoveryActions: ['restart_on_source', 'keep_stopped'],
            },
          };
        },
      );
      const canonical = await input.abort({
        handoffId: parsed.data.handoffId,
        reason: parsed.data.reason,
      });
      const canonicalResponse = asRecord(canonical);
      return projectStatusResponseForPredecessor({
        ...(canonicalResponse ?? {}),
        handoffId: parsed.data.handoffId,
        status: canonicalResponse?.status ?? transitioned?.status ?? job.status,
        targetCleanup: transitioned?.recordKind === 'prepared_target'
          ? transitioned.targetCleanup
          : job.targetCleanup,
      });
    },
  );
}
