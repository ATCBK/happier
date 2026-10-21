import type {
  AgentSessionCatalogControl,
  AgentSessionContinuationControl,
  AgentSessionControlContext,
  AgentSessionGoalControl,
  AgentSessionGoalControlContext,
  AgentSessionUsageLimitRecoveryControl,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import {
  listCodexAppServerSkills,
  listCodexVendorPlugins,
} from './appServer/catalog/index.js';
import { createCodexNativeAppServerClient } from './appServer/client.js';
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

async function withControlClient<T>(
  context: AgentSessionControlContext,
  run: (client: Awaited<ReturnType<typeof createCodexNativeAppServerClient>>) => Promise<T>,
): Promise<T> {
  const client = await createCodexNativeAppServerClient({
    exec: context.services.exec,
    cwd: context.session.cwd,
    processEnv: {},
    signal: context.signal,
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
      try {
        const response = await withControlClient(context, async (client) => await client.request('thread/goal/get', { threadId }));
        phase = 'host_publication_rejected';
        return await goalProjection.publish(readCodexGoalPayload(response), context.goalSource);
      } catch {
        return { status: 'unavailable', retryable: true, diagnostic: diagnostic('codex_goal_read_failed'), goalControlFailure: { phase } };
      }
    },
    async set(mutation, context) {
      const threadId = context.session.providerSessionId;
      if (!threadId) return { status: 'unavailable', retryable: false, diagnostic: diagnostic('codex_goal_thread_unavailable'), goalControlFailure: { phase: 'native_effect' } };
      let phase: 'native_effect' | 'host_publication_rejected' = 'native_effect';
      try {
        const response = await withControlClient(context, async (client) => await client.request('thread/goal/set', {
          threadId,
          ...mutation,
        }));
        phase = 'host_publication_rejected';
        return await goalProjection.publish(readCodexGoalPayload(response), context.goalSource);
      } catch {
        return { status: 'unavailable', retryable: true, diagnostic: diagnostic('codex_goal_write_failed'), goalControlFailure: { phase } };
      }
    },
    async clear(context) {
      const threadId = context.session.providerSessionId;
      if (!threadId) return { status: 'unavailable', retryable: false, diagnostic: diagnostic('codex_goal_thread_unavailable'), goalControlFailure: { phase: 'native_effect' } };
      let phase: 'native_effect' | 'host_publication_rejected' = 'native_effect';
      try {
        await withControlClient(context, async (client) => await client.request('thread/goal/clear', { threadId }));
        phase = 'host_publication_rejected';
        return await goalProjection.publish({ kind: 'absent' }, context.goalSource);
      } catch {
        return { status: 'unavailable', retryable: true, diagnostic: diagnostic('codex_goal_clear_failed'), goalControlFailure: { phase } };
      }
    },
  };
}

const catalog: AgentSessionCatalogControl = {
  async list(request, context) {
    let phase: 'startup' | 'request' = 'startup';
    try {
      return await withControlClient(context, async (client) => {
        phase = 'request';
        if (request.kind === 'vendorPlugins') {
          const result = await listCodexVendorPlugins({ client, cwd: context.session.cwd });
          if (!result.supported) return { status: 'unsupported' as const, diagnostic: diagnostic('codex_vendor_catalog_unsupported') };
          return {
            status: 'ok' as const,
            kind: 'vendorPlugins' as const,
            items: result.vendorPlugins.map((item) => ({
              id: item.vendorPluginRef,
              name: item.name,
              displayName: item.displayName,
              ...(item.description ? { description: item.description } : {}),
              installed: item.installed,
              enabled: item.enabled,
              mentionable: item.mentionable,
            })),
          };
        }
        const result = await listCodexAppServerSkills({ client, cwd: context.session.cwd });
        if (!result.supported) return { status: 'unsupported' as const, diagnostic: diagnostic('codex_skill_catalog_unsupported') };
        return {
          status: 'ok' as const,
          kind: 'skills' as const,
          items: result.skills.map((item) => ({
            v: 1 as const,
            origin: 'vendor' as const,
            id: item.id,
            name: item.name,
            displayName: item.displayName ?? item.name,
            ...(item.description ? { description: item.description } : {}),
            path: item.path,
            enabled: item.enabled,
          })),
        };
      });
    } catch (error) {
      const { errorClass, errorCode, httpStatus } = readUnexpectedActionErrorDiagnosticV1(error);
      const details = { phase, errorClass, errorCode, httpStatus };
      context.services.logger.warn('codex_catalog_read_failed', details);
      return { status: 'unavailable', retryable: true,
        diagnostic: { ...diagnostic(`codex_catalog_${phase}_failed`), details } };
    }
  },
};

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
  return Object.freeze({
    goals: createGoalControl(goalProjection),
    catalog,
    usageLimitRecovery,
    continuation,
  });
}
