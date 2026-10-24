import type {
  AgentSessionCatalogControl,
  AgentSessionContinuationControl,
  AgentSessionControlContext,
  AgentSessionGoalControl,
  AgentSessionGoalControlContext,
  AgentSessionUsageLimitRecoveryControl,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
  readUnexpectedActionErrorDiagnosticV1,
  projectSessionGoalControlDiagnosticDetails,
  type SessionGoalControlDiagnosticStage,
} from '@happier-dev/protocol/actions/actionExecutionResult';

import {
  readCodexSessionCatalog,
  type CodexSessionCatalogReader,
} from './appServer/catalog/index.js';
import { createCodexNativeAppServerClient } from './appServer/client.js';
import { isCodexAppServerApplicationRejectionForMethod } from './appServer/compatibility.js';
import {
  createCodexGoalProjection,
  readCodexGoalPayload,
  type CodexGoalProjection,
} from './appServer/work/goalProjection.js';
import {
  isCodexRateLimitSnapshotExhausted,
  readEarliestCodexRateLimitResetAtMs,
} from '../auth/services/quota/rateLimitSnapshot.js';
import { readCodexRuntimeRateLimitsSnapshot } from '../auth/services/quota/runtimeRateLimits.js';

function diagnostic(code: string, message = code) {
  return { code, severity: 'error' as const, message };
}

function readGoalRefusalCondition(error: unknown, stage: SessionGoalControlDiagnosticStage) {
  if (!stage.startsWith('thread/goal/') || !(error instanceof Error)
    || !isCodexAppServerApplicationRejectionForMethod(error, stage)
    || !('code' in error) || error.code !== -32600) return 'unclassified';
  // rust-v0.162.1 thread_goal_processor.rs: the same RPC code covers feature,
  // lookup and ownership failures. Never project native prose or thread ids.
  if (error.message === 'goals feature is disabled') return 'goals_disabled';
  if (error.message.startsWith('thread not found: ')) return 'thread_not_found';
  if (error.message.startsWith('ephemeral thread does not support goals: ')) return 'ephemeral_thread';
  if (error.message === 'thread metadata does not match requested id') return 'thread_identity_mismatch';
  return 'unclassified';
}

function goalFailureResult(
  context: AgentSessionControlContext,
  code: string,
  error: unknown,
  stage: SessionGoalControlDiagnosticStage,
  phase: 'native_effect' | 'host_publication_rejected',
) {
  const condition = readGoalRefusalCondition(error, stage);
  const details = projectSessionGoalControlDiagnosticDetails(stage, error);
  context.services.logger?.debug('Codex Goal control failed', { condition, ...details });
  if (condition === 'goals_disabled') {
    return { status: 'unsupported' as const,
      diagnostic: { ...diagnostic('codex_goals_disabled'), details }, goalControlFailure: { phase } };
  }
  return { status: 'unavailable' as const, retryable: true,
    diagnostic: { ...diagnostic(code), details }, goalControlFailure: { phase } };
}

async function withControlClient<T>(
  context: AgentSessionControlContext,
  run: (client: Awaited<ReturnType<typeof createCodexNativeAppServerClient>>) => Promise<T>,
  onInitialize?: () => void,
): Promise<T> {
  const client = await createCodexNativeAppServerClient({
    exec: context.services.exec,
    logger: context.services.logger,
    cwd: context.session.cwd,
    processEnv: {},
    signal: context.signal,
    ...(onInitialize ? { onInitialize } : {}),
  });
  try {
    return await run(client);
  } finally {
    await client.dispose().catch(() => undefined);
  }
}

function createGoalControl(goalProjection: CodexGoalProjection): AgentSessionGoalControl {
  return {
    async get(context) {
      const threadId = context.session.providerSessionId;
      if (!threadId) return { status: 'unavailable', retryable: false, diagnostic: diagnostic('codex_goal_thread_unavailable'), goalControlFailure: { phase: 'native_effect' } };
      let phase: 'native_effect' | 'host_publication_rejected' = 'native_effect';
      let stage: SessionGoalControlDiagnosticStage = 'client_creation';
      try {
        const response = await withControlClient(context, async (client) => {
          stage = 'thread/goal/get';
          return await client.request('thread/goal/get', { threadId });
        }, () => { stage = 'initialize'; });
        phase = 'host_publication_rejected';
        stage = 'host_publication';
        return await goalProjection.publish(readCodexGoalPayload(response), context.goalSource);
      } catch (error) {
        return goalFailureResult(context, 'codex_goal_read_failed', error, stage, phase);
      }
    },
    async set(mutation, context) {
      const threadId = context.session.providerSessionId;
      if (!threadId) return { status: 'unavailable', retryable: false, diagnostic: diagnostic('codex_goal_thread_unavailable'), goalControlFailure: { phase: 'native_effect' } };
      let phase: 'native_effect' | 'host_publication_rejected' = 'native_effect';
      let stage: SessionGoalControlDiagnosticStage = 'client_creation';
      try {
        const response = await withControlClient(context, async (client) => {
          stage = 'thread/goal/set';
          return await client.request('thread/goal/set', { threadId, ...mutation });
        }, () => { stage = 'initialize'; });
        phase = 'host_publication_rejected';
        stage = 'host_publication';
        return await goalProjection.publish(readCodexGoalPayload(response), context.goalSource);
      } catch (error) {
        return goalFailureResult(context, 'codex_goal_write_failed', error, stage, phase);
      }
    },
    async clear(context) {
      const threadId = context.session.providerSessionId;
      if (!threadId) return { status: 'unavailable', retryable: false, diagnostic: diagnostic('codex_goal_thread_unavailable'), goalControlFailure: { phase: 'native_effect' } };
      let phase: 'native_effect' | 'host_publication_rejected' = 'native_effect';
      let stage: SessionGoalControlDiagnosticStage = 'client_creation';
      try {
        await withControlClient(context, async (client) => {
          stage = 'thread/goal/clear';
          await client.request('thread/goal/clear', { threadId });
        }, () => { stage = 'initialize'; });
        phase = 'host_publication_rejected';
        stage = 'host_publication';
        return await goalProjection.publish({ kind: 'absent' }, context.goalSource);
      } catch (error) {
        return goalFailureResult(context, 'codex_goal_clear_failed', error, stage, phase);
      }
    },
  };
}

const createCatalog = (readSessionCatalog: (sessionId: string) => CodexSessionCatalogReader | undefined): AgentSessionCatalogControl => ({
  async list(request, context) {
    let phase: 'startup' | 'request' = 'startup';
    try {
      const readLiveCatalog = readSessionCatalog(context.session.id);
      if (readLiveCatalog) {
        phase = 'request';
        return await readLiveCatalog(request, { signal: context.signal });
      }
      return await withControlClient(context, async (client) => {
        phase = 'request';
        return await readCodexSessionCatalog(request, {
          client: { request: (method, params) => client.request(method, params, { signal: context.signal }) },
          cwd: context.session.cwd,
        });
      });
    } catch (error) {
      const { errorClass, errorCode, httpStatus } = readUnexpectedActionErrorDiagnosticV1(error);
      const details = { phase, errorClass, errorCode, httpStatus };
      context.services.logger.warn('codex_catalog_read_failed', details);
      return { status: 'unavailable', retryable: true,
        diagnostic: { ...diagnostic(`codex_catalog_${phase}_failed`), details } };
    }
  },
});

const usageLimitRecovery: AgentSessionUsageLimitRecoveryControl = {
  async execute(request, context) {
    if (request.kind !== 'checkNow') {
      return { status: 'unsupported', diagnostic: diagnostic('codex_reset_credit_unsupported') };
    }
    try {
      const snapshot = await withControlClient(context, async (client) => (
        await readCodexRuntimeRateLimitsSnapshot(client)
      ).rawSnapshot);
      if (!isCodexRateLimitSnapshotExhausted(snapshot)) return { status: 'ready' };
      const resetAtMs = readEarliestCodexRateLimitResetAtMs(snapshot);
      return {
        status: 'waiting',
        ...(resetAtMs === null ? {} : { retryAfterMs: Math.max(0, resetAtMs - Date.now()) }),
      };
    } catch {
      return { status: 'unavailable', retryable: true, diagnostic: diagnostic('codex_usage_limit_probe_failed') };
    }
  },
};

const continuation: AgentSessionContinuationControl = {
  async verify(request, context) {
    const providerSessionId = request.kind === 'resume'
      ? request.providerSessionId
      : request.source.providerSessionId;
    try {
      await withControlClient(context, async (client) => await client.request('thread/read', {
        threadId: providerSessionId,
        includeTurns: false,
      }));
      return { status: 'reachable' };
    } catch (error) {
      const { errorClass, errorCode, httpStatus } = readUnexpectedActionErrorDiagnosticV1(error);
      const details = { errorClass, errorCode, httpStatus };
      // Required verification is refused before sessions.open. Record the safe
      // cause here, before the host replaces this diagnostic with exit 78.
      context.services.logger.warn('codex_continuation_unreachable', details);
      return { status: 'unreachable', diagnostic: { ...diagnostic('codex_continuation_unreachable'), details } };
    }
  },
};

export function createCodexNativeSessionControls(
  goalProjection: CodexGoalProjection = createCodexGoalProjection(),
) {
  // The runtime owns its native client, delivered roots and disposal.
  const catalogReaders = new Map<string, CodexSessionCatalogReader>();
  return Object.freeze({
    goals: createGoalControl(goalProjection),
    catalog: createCatalog(sessionId => catalogReaders.get(sessionId)),
    usageLimitRecovery,
    continuation,
    bindSessionCatalog(sessionId: string, readCatalog: CodexSessionCatalogReader) {
      catalogReaders.set(sessionId, readCatalog);
      return () => {
        if (catalogReaders.get(sessionId) === readCatalog) catalogReaders.delete(sessionId);
      };
    },
  });
}

export type CodexSessionCatalogBinder = ReturnType<typeof createCodexNativeSessionControls>['bindSessionCatalog'];
