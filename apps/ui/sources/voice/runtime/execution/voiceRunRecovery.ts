import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveVoiceAgentRunBackendId } from '@happier-dev/protocol/voice/voiceAgentRunMetadataV1';
import type { VoiceAgentHandle } from '@/voice/agent/types';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { isVoiceAgentNotFoundError } from '@/voice/agent/voiceAgentErrorGuards';
import { readPersistedVoiceConversationRuntimeState } from '@/voice/binding/voiceConversationBindingPersistence';
import { readVoiceAgentRunMetadataFromSession } from '@/voice/persistence/voiceAgentRunMetadata';
import {
  sessionExecutionRunGet,
  sessionExecutionRunList,
  sessionExecutionRunStop,
} from '@/sync/ops/sessionExecutionRuns';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { createAbortRacer } from '@/voice/agent/voiceAgentAbort';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import {
  clearVoiceAgentRunMetadata,
  persistVoiceAgentRunMetadata,
  resolveVoiceRunMetadataSessionId,
} from '@/voice/agent/voiceAgentRunState';

export function createVoiceRunRecovery(
  args: Readonly<{
    createHandle: (sessionId: string) => Promise<VoiceAgentHandle>;
    voiceAgentBySessionId: Map<string, VoiceAgentHandle>;
    voiceAgentInitBySessionId: Map<string, Promise<VoiceAgentHandle>>;
    voiceAttemptExplicitContextBySessionId: Map<string, string[]>;
    deferredTargetSessionContextBySessionId: Map<string, string | null>;
    latestAutomaticUiContextBySessionId: Map<string, string>;
  }>,
): Readonly<{
  appendAttemptContextUpdate: (sessionId: string, update: string) => void;
  appendAutomaticUiContextUpdate: (sessionId: string, update: string) => void;
  commit: (sessionId: string) => Promise<string>;
  ensureRunning: (sessionId: string) => Promise<void>;
  getVoiceAgentHandle: (sessionId: string) => Promise<VoiceAgentHandle>;
  isActive: (sessionId: string) => boolean;
  resetCachedHandle: (sessionId: string) => void;
  prepareStop: (
    sessionId: string,
    beforeStop?: () => Promise<void>,
    reason?: 'continued_elsewhere',
  ) => Readonly<{
    accountLifetime: ServerAccountScopeLifetime | null;
    run: (signal?: AbortSignal) => Promise<void>;
  }>;
}> {
  const getVoiceAgentHandle = async (
    sessionId: string,
  ): Promise<VoiceAgentHandle> => {
    const existing = args.voiceAgentBySessionId.get(sessionId);
    if (existing) return existing;
    const pending = args.voiceAgentInitBySessionId.get(sessionId);
    if (pending) return await pending;

    const init = args.createHandle(sessionId);
    args.voiceAgentInitBySessionId.set(sessionId, init);
    try {
      const handle = await init;
      if (
        args.voiceAgentInitBySessionId.get(sessionId) === init &&
        handle.accountLifetime.isCurrent()
      ) {
        args.voiceAgentBySessionId.set(sessionId, handle);
      }
      return handle;
    } finally {
      if (args.voiceAgentInitBySessionId.get(sessionId) === init)
        args.voiceAgentInitBySessionId.delete(sessionId);
    }
  };

  const commit = async (sessionId: string): Promise<string> => {
    const commitWithHandle = async () => {
      const handle = await getVoiceAgentHandle(sessionId);
      const response = await handle.client.commit({
        sessionId: handle.rpcSessionId,
        voiceAgentId: handle.voiceAgentId,
        kind: 'session_instruction',
      });

      if (handle.backend === 'daemon') {
        const metadataSessionId = handle.metadataSessionId;
        if (metadataSessionId) {
          try {
            const getRes = await sessionExecutionRunGet(
              handle.rpcSessionId,
              {
                runId: handle.voiceAgentId,
                includeStructured: false,
              },
              { scope: handle.accountLifetime.scope, signal: handle.signal },
            );
            if ('run' in getRes) {
              await persistVoiceAgentRunMetadata(metadataSessionId, {
                runId: handle.voiceAgentId,
                backendTarget: getRes.run.backendTarget,
                resumeHandle: getRes.run.resumeHandle ?? null,
                accountLifetime: handle.accountLifetime,
              });
            }
          } catch {
            // best-effort only
          }
        }
      }
      return response.commitText;
    };

    try {
      return await commitWithHandle();
    } catch (error) {
      if (!isVoiceAgentNotFoundError(error)) {
        throw error;
      }
      args.voiceAgentBySessionId.delete(sessionId);
      return await commitWithHandle();
    }
  };

  const prepareStop = (
    sessionId: string,
    beforeStop?: () => Promise<void>,
    reason?: 'continued_elsewhere',
  ) => {
    const admittedLifetime = captureActiveServerAccountScopeLifetime();
    const persistedRuntimeState = readPersistedVoiceConversationRuntimeState({
      managedSessionId: sessionId,
    });
    const metadataSessionId =
      persistedRuntimeState?.metadataSessionId ??
      resolveVoiceRunMetadataSessionId(sessionId, 'daemon');
    const persistedRunMeta =
      persistedRuntimeState?.runMetadata ??
      (metadataSessionId
        ? readVoiceAgentRunMetadataFromSession({ sessionId: metadataSessionId })
        : null);
    const existingHandle = args.voiceAgentBySessionId.get(sessionId) ?? null;
    const pendingInit = args.voiceAgentInitBySessionId.get(sessionId) ?? null;
    args.voiceAgentInitBySessionId.delete(sessionId);
    args.voiceAgentBySessionId.delete(sessionId);
    args.voiceAttemptExplicitContextBySessionId.delete(sessionId);
    args.deferredTargetSessionContextBySessionId.delete(sessionId);
    args.latestAutomaticUiContextBySessionId.delete(sessionId);
    const run = async (signal?: AbortSignal): Promise<void> => {
      const caller = createAbortRacer(signal);
      caller.throwIfAborted();
      await caller.race(Promise.resolve(beforeStop?.()));

      const handle = existingHandle
        ? existingHandle
        : pendingInit
          ? await caller.race(pendingInit.catch(() => null))
          : null;

      // A connected continuation retires this client's custody only. The
      // same carrier/run now serves the arriving client; neither the old
      // handle nor a metadata fallback authorizes stopping it or clearing it.
      if (reason === 'continued_elsewhere') return;

      const accountLifetime = handle?.accountLifetime ?? admittedLifetime;
      if (!accountLifetime) return;
      const runOptions = { scope: accountLifetime.scope, signal };
      // Unobserved cleanup remains best effort. An ordered caller must know
      // when Stop was not acknowledged before it may admit a successor.
      const cleanupFailure = (error: unknown): undefined => {
        if (signal && !isVoiceAgentNotFoundError(error)) throw error;
        return undefined;
      };
      const stopRun = async (
        rpcSessionId: string,
        runId: string,
      ): Promise<void> => {
        const stopped = await sessionExecutionRunStop(
          rpcSessionId,
          { runId },
          runOptions,
        ).catch(cleanupFailure);
        if (stopped?.ok === false) {
          cleanupFailure(
            createRpcCallError({
              error: stopped.error,
              errorCode: stopped.errorCode,
            }),
          );
        }
      };
      const cleanupMetadataSessionId = handle
        ? handle.metadataSessionId
        : metadataSessionId;

      const fallbackRpcSessionId =
        sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
          ? (metadataSessionId ?? sessionId)
          : sessionId;
      const daemonRpcSessionId =
        handle?.backend === 'daemon'
          ? handle.rpcSessionId
          : fallbackRpcSessionId;
      const daemonBackendId = normalizeNonEmptyString(
        handle?.backend === 'daemon'
          ? handle.agentBackendId
          : (persistedRunMeta?.backendId ?? null),
      );

      if (handle) {
        try {
          await handle.client.stop({
            sessionId: handle.rpcSessionId,
            voiceAgentId: handle.voiceAgentId,
            signal,
          });
        } catch (error) {
          cleanupFailure(error);
        }
      } else if (persistedRunMeta?.runId) {
        await stopRun(fallbackRpcSessionId, persistedRunMeta.runId);
      }

      if (daemonBackendId) {
        const listed = await Promise.resolve(
          sessionExecutionRunList(daemonRpcSessionId, {}, runOptions),
        ).catch(cleanupFailure);
        if (listed && !('runs' in listed)) {
          cleanupFailure(
            createRpcCallError({
              error: listed.error,
              errorCode: listed.errorCode,
            }),
          );
        }
        const runs = listed && 'runs' in listed ? listed.runs : [];
        const matchingRunIds: string[] = Array.from(
          new Set(
            runs
              .filter(
                (run) =>
                  run.intent === 'voice_agent' &&
                  run.status === 'running' &&
                  resolveVoiceAgentRunBackendId(run.backendTarget) ===
                    daemonBackendId,
              )
              .map((run) => run.runId),
          ),
        );
        for (const runId of matchingRunIds) {
          await stopRun(daemonRpcSessionId, runId);
        }
      }

      await clearVoiceAgentRunMetadata(
        cleanupMetadataSessionId,
        accountLifetime,
      ).catch(() => {});
    };
    return {
      accountLifetime: existingHandle?.accountLifetime ?? admittedLifetime,
      run,
    };
  };

  const appendAttemptContextUpdate = (
    sessionId: string,
    update: string,
  ): void => {
    const text = update.trim();
    if (!text) return;

    const existing =
      args.voiceAttemptExplicitContextBySessionId.get(sessionId) ?? [];
    args.voiceAttemptExplicitContextBySessionId.set(sessionId, [
      ...existing,
      text,
    ]);
  };

  const appendAutomaticUiContextUpdate = (
    sessionId: string,
    update: string,
  ): void => {
    const text = update.trim();
    if (!text) return;
    args.latestAutomaticUiContextBySessionId.set(sessionId, text);
  };

  return {
    appendAttemptContextUpdate,
    appendAutomaticUiContextUpdate,
    commit,
    ensureRunning: async (sessionId: string) => {
      await getVoiceAgentHandle(sessionId);
    },
    getVoiceAgentHandle,
    isActive: (sessionId: string) => args.voiceAgentBySessionId.has(sessionId),
    resetCachedHandle: (sessionId: string) => {
      args.voiceAgentBySessionId.delete(sessionId);
    },
    prepareStop,
  };
}
