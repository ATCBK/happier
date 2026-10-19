import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { randomUUID } from 'node:crypto';
import { SessionWorkStateV1Schema as SessionStateWorkStateValueSchema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { SessionInitialGoalRequestV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import type { ActionExecutorContext, SessionGoalSetRequestV1 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { resolveInactiveSessionGoalControls } from '@/agent/catalog/sessionControlAdapters';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { StoredCredentials } from '@/persistence';
import {
  resolveMachineControlLocalityProof,
  resolveSessionMachineWorkspacePath,
} from '@/session/machineControlLocality';
import { splitDurableRegisteredSessionStateMetadata } from '@/agent/runtime/registry/pluginMetadataDurability';
import type { DaemonWorkStateFieldMutation } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { requestInactiveSessionResume } from '@/session/services/requestInactiveSessionResume';
import { logger } from '@/ui/logger';
import { awaitGoalAcknowledgement } from './awaitGoalAcknowledgement';
import { happierSessionGoalControlAdapter } from './happierSessionGoalControlAdapter';
import type {
  ResolveSessionGoalControlAdapter,
  SessionGoalControlAdapterParams,
  SessionGoalControlOperation,
  SessionGoalControlTarget,
} from './sessionGoalControlTypes';

type RouteSessionGoalControlParams = Readonly<{
  token: string;
  credentials?: StoredCredentials;
  sessionId: string;
  rawSession: SessionGoalControlTarget;
  metadata: Record<string, unknown> | null;
  currentMachineId: string | null;
  currentMachineHost?: string | null;
  currentMachineHomeDir?: string | null;
  operation: SessionGoalControlOperation;
  request?: SessionGoalSetRequestV1;
  resumeInactiveWithInitialGoal?: boolean;
  signal?: AbortSignal;
  actionRequestId?: string;
  executionAuthority?: ActionExecutorContext['authority'];
  callMachineGoalRpc?: (input: Readonly<{
    machineId: string;
    operation: SessionGoalControlOperation;
    request?: SessionGoalSetRequestV1;
    resumeInactiveWithInitialGoal: boolean;
  }>) => Promise<unknown>;
  machineResumeTransport?: Parameters<typeof requestInactiveSessionResume>[0]['machineRpcTransport'];
  callLiveSessionRpc: () => Promise<unknown>;
  resolveAdapter?: ResolveSessionGoalControlAdapter;
  stageWorkStateMutation?: (mutation: DaemonWorkStateFieldMutation, options?: Readonly<{ signal?: AbortSignal }>) => Promise<void>;
}> & SessionStoredContentCryptoContext;

function stableError(errorCode: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode, error: errorCode };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveRawSessionString(rawSession: SessionGoalControlTarget, key: 'path' | 'machineId' | 'host' | 'homeDir'): string | null {
  return readString((rawSession as Partial<Record<typeof key, unknown>>)[key]);
}

function resolveSessionMachineHost(
  metadata: Record<string, unknown>,
  rawSession: SessionGoalControlTarget,
): string | null {
  return readString(metadata.host) ?? resolveRawSessionString(rawSession, 'host');
}

function resolveSessionMachineHomeDir(
  metadata: Record<string, unknown>,
  rawSession: SessionGoalControlTarget,
): string | null {
  return readString(metadata.homeDir) ?? resolveRawSessionString(rawSession, 'homeDir');
}

function resolveAgentId(metadata: Record<string, unknown>): CatalogAgentId | null {
  return resolveAgentIdFromSessionMetadata(metadata);
}

function buildAdapterParams(
  params: RouteSessionGoalControlParams,
  metadata: Record<string, unknown>,
  sessionMachineId: string,
): SessionGoalControlAdapterParams {
  const base = {
    token: params.token,
    ...(params.credentials ? { credentials: params.credentials } : {}),
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    metadata,
    currentMachineId: params.currentMachineId,
    sessionMachineId,
    ...(params.signal ? { signal: params.signal } : {}),
    cwd: resolveSessionMachineWorkspacePath({
      metadata,
      currentMachineId: params.currentMachineId,
      candidatePath: resolveRawSessionString(params.rawSession, 'path') ?? readString(metadata.path),
    }),
  } as const;
  return params.mode === 'plain'
    ? { ...base, mode: params.mode, ctx: params.ctx }
    : { ...base, mode: params.mode, ctx: params.ctx };
}

function readMetadataResult(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return metadata as Record<string, unknown>;
}

function shouldFallbackFromLiveSessionGoalRpc(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const raw = result as Record<string, unknown>;
  const errorCode = typeof raw.errorCode === 'string' ? raw.errorCode : '';
  const error = typeof raw.error === 'string' ? raw.error : '';
  // Only definitive missing-method signals admit the declared inactive facet.
  // A transport failure may follow an accepted live effect; invoking another
  // writer would duplicate it. Keep that uncertain result with the caller.
  return errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
    || errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
    || errorCode === 'unsupported_session_runtime_method'
    || error === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
    || error === RPC_ERROR_CODES.METHOD_NOT_FOUND
    || error === 'unsupported_session_runtime_method';
}

async function persistAdapterMetadataResult(
  params: RouteSessionGoalControlParams,
  result: unknown,
): Promise<unknown> {
  const nextMetadata = readMetadataResult(result);
  if (!nextMetadata || !Object.prototype.hasOwnProperty.call(nextMetadata, 'sessionWorkStateV1')) return result;
  if (nextMetadata.sessionWorkStateV1 !== null
    && !SessionStateWorkStateValueSchema.safeParse(nextMetadata.sessionWorkStateV1).success) {
    throw new Error('invalid_daemon_work_state_mutation');
  }
  const split = splitDurableRegisteredSessionStateMetadata({
    sessionId: params.sessionId,
    current: params.metadata,
    candidate: nextMetadata,
    source: 'daemon',
  });
  const mutations = split.mutations.filter((mutation): mutation is DaemonWorkStateFieldMutation =>
    mutation.fieldId === 'runtime.workState' && mutation.source === 'daemon' && mutation.deliveryClass === 'durable_required');
  if (mutations.length === 0) return result;
  if (!params.stageWorkStateMutation) return stableError('session_goal_control_work_state_custody_unavailable');
  const startedAt = performance.now();
  // The native facet may acknowledge an already-admitted effect after caller
  // cancellation. Retain its truthful publication even though that receipt ended.
  for (const mutation of mutations) {
    await params.stageWorkStateMutation(mutation, { signal: params.signal?.aborted ? undefined : params.signal });
  }
  logger.debug('[SessionGoal] Work-state settlement', { sessionId: params.sessionId, operation: params.operation,
    durationMs: Math.round(performance.now() - startedAt) });
  return result;
}

export async function routeSessionGoalControl(params: RouteSessionGoalControlParams): Promise<unknown> {
  return await awaitGoalAcknowledgement(() => executeSessionGoalControl(params), params.signal);
}

async function executeSessionGoalControl(params: RouteSessionGoalControlParams): Promise<unknown> {
  const startedAt = performance.now();
  let phaseStartedAt = startedAt;
  const phase = (name: 'live_rpc' | 'locality' | 'inactive_resume' | 'adapter_resolution' | 'native_control') => {
    const now = performance.now();
    logger.debug('[SessionGoal] Routing phase', { sessionId: params.sessionId, operation: params.operation, phase: name,
      durationMs: Math.round(now - phaseStartedAt), elapsedMs: Math.round(now - startedAt) });
    phaseStartedAt = now;
  };
  params.signal?.throwIfAborted();
  if (params.rawSession.active === true) {
    const liveResult = await params.callLiveSessionRpc();
    phase('live_rpc');
    if (!shouldFallbackFromLiveSessionGoalRpc(liveResult)) {
      return liveResult;
    }
  }

  const metadata = params.metadata;
  if (!metadata) {
    return stableError('session_goal_control_metadata_unavailable');
  }

  const currentMachineId = readString(params.currentMachineId);
  if (!currentMachineId) {
    return stableError('session_goal_control_current_machine_unknown');
  }

  const metadataMachineId = readString(metadata.machineId);
  const rawMachineId = resolveRawSessionString(params.rawSession, 'machineId');
  if (metadataMachineId && rawMachineId && metadataMachineId !== rawMachineId) {
    return stableError('session_goal_control_target_machine_mismatch');
  }
  const sessionMachineId = metadataMachineId ?? rawMachineId;
  if (!sessionMachineId) {
    return stableError('session_goal_control_session_machine_unknown');
  }
  const inactiveSession = params.rawSession.active === false ? params.rawSession : null;
  const initialGoal = params.operation === 'set' && params.resumeInactiveWithInitialGoal === true
    && inactiveSession !== null ? SessionInitialGoalRequestV1Schema.safeParse(params.request) : null;
  if (initialGoal && !initialGoal.success) return stableError('invalid_parameters');
  const locality = await resolveMachineControlLocalityProof({
      sessionMachineId,
      currentMachineId,
      sessionHost: resolveSessionMachineHost(metadata, params.rawSession),
      sessionHomeDir: resolveSessionMachineHomeDir(metadata, params.rawSession),
      currentMachineHost: params.currentMachineHost,
      currentMachineHomeDir: params.currentMachineHomeDir,
      credentials: { token: params.token },
    });
  phase('locality');
  if (!locality) {
    params.signal?.throwIfAborted();
    if (params.callMachineGoalRpc) {
      return await params.callMachineGoalRpc({ machineId: sessionMachineId, operation: params.operation,
        ...(params.request ? { request: params.request } : {}), resumeInactiveWithInitialGoal: initialGoal?.success === true });
    }
    return stableError('session_goal_control_remote_unavailable');
  }

  params.signal?.throwIfAborted();
  if (initialGoal?.success && !params.credentials) return stableError('not_authenticated');

  if (!params.stageWorkStateMutation && params.callMachineGoalRpc) {
    // Same-Machine Action hosts do not own the daemon's durable outbox. Native
    // controls (including Get) may publish refreshed work state, so delegate
    // before opening any inactive facet or accepting its native effect.
    return await params.callMachineGoalRpc({ machineId: sessionMachineId, operation: params.operation,
      ...(params.request ? { request: params.request } : {}), resumeInactiveWithInitialGoal: initialGoal?.success === true });
  }
  const resolveAdapter = params.resolveAdapter ?? resolveInactiveSessionGoalControls;
  const adapter = await resolveAdapter(resolveAgentId(metadata)) ?? happierSessionGoalControlAdapter;
  phase('adapter_resolution');
  params.signal?.throwIfAborted();
  const adapterParams = buildAdapterParams(params, metadata, sessionMachineId);
  let result: unknown;
  if (params.operation === 'get') {
    result = typeof adapter.getGoal === 'function'
      ? await adapter.getGoal(adapterParams)
      : stableError('session_goal_control_unsupported');
    phase('native_control');
    return await persistAdapterMetadataResult(params, result);
  }
  if (params.operation === 'clear') {
    result = typeof adapter.clearGoal === 'function'
      ? await adapter.clearGoal(adapterParams)
      : stableError('session_goal_control_unsupported');
    phase('native_control');
    return await persistAdapterMetadataResult(params, result);
  }
  if (!params.request || typeof adapter.setGoal !== 'function') {
    return stableError('session_goal_control_unsupported');
  }
  result = await adapter.setGoal({
    ...adapterParams,
    request: params.request,
  });
  phase('native_control');
  const needsLiveGoal = initialGoal?.success === true && result !== null && typeof result === 'object'
    && 'status' in result && result.status === 'unsupported'
    && 'errorCode' in result && result.errorCode === 'inactive_agent_control_unsupported';
  result = await persistAdapterMetadataResult(params, result);
  if (!initialGoal?.success || !inactiveSession || (!needsLiveGoal && result && typeof result === 'object' && 'ok' in result && result.ok === false)) {
    return result;
  }
  params.signal?.throwIfAborted();
  // Native inactive writers retain their acknowledged Goal before reopening.
  // An inactive facet that cannot write must enter the same live RPC after
  // readiness; neither metadata nor the spawn receipt applies its Goal.
  const resumed = await requestInactiveSessionResume({ credentials: params.credentials!,
    sessionId: params.sessionId, rawSession: inactiveSession, metadata: readMetadataResult(result) ?? metadata,
    requestId: params.actionRequestId ?? randomUUID(), executionAuthority: params.executionAuthority,
    ...(needsLiveGoal ? { waitForReady: true } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.machineResumeTransport ? { machineRpcTransport: params.machineResumeTransport } : {}) });
  phase('inactive_resume');
  if (!resumed.ok) return { ok: false, errorCode: resumed.code, error: resumed.message };
  params.signal?.throwIfAborted();
  return needsLiveGoal ? await params.callLiveSessionRpc() : result;
}
