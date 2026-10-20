import type { AgentExternalSessionsContribution, AgentExternalSessionsInvocationBounds, AgentExternalSessionsResult } from '@happier-dev/plugin-sdk/sessions/external';
import { createAgentExternalSessionsProducerOverflowFailure, getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { listCodeBuddyCandidates } from './candidates.js';
import { CodeBuddySourceError, discoverCodeBuddyFiles, resolveCodeBuddyFile, resolveCodeBuddySource } from './source.js';
import { pageCodeBuddyTranscript, readAfterCodeBuddyTranscript } from './transcript.js';

export function createCodeBuddyExternalSessionsContribution(env: NodeJS.ProcessEnv = process.env): AgentExternalSessionsContribution {
  async function guarded<T>(invocation: AgentExternalSessionsInvocationBounds, operation: () => Promise<T>): Promise<AgentExternalSessionsResult<T>> {
    try {
      const value = await operation();
      const result = getAgentExternalSessionsInvocationFailure(invocation) ?? { ok: true as const, value };
      return isAgentExternalSessionsResultWithinByteBudget(result, invocation.maxSerializedBytes) ? result
        : createAgentExternalSessionsProducerOverflowFailure('CodeBuddy result does not fit the supplied result allowance.');
    } catch (error) {
      const failure = getAgentExternalSessionsInvocationFailure(invocation); if (failure) return failure;
      if (error instanceof CodeBuddySourceError) return { ok: false, code: error.code === 'source_unavailable' ? 'unavailable' : error.code === 'source_discontinuity' ? 'source_invalid' : error.code, message: error.message };
      if (error instanceof Error && error.name === 'AbortError') return { ok: false, code: 'cancelled' };
      return { ok: false, code: 'agent_error', message: 'CodeBuddy native history read failed.', retryable: true };
    }
  }
  const identity: AgentExternalSessionsContribution['resolveLinkIdentity'] = async request => {
    const failure = getAgentExternalSessionsInvocationFailure(request); if (failure) return failure;
    return guarded(request, async () => {
      const resolved = await resolveCodeBuddySource(request.source, env);
      const file = await resolveCodeBuddyFile(resolved.root, { ...resolved.source, ...(typeof request.linkData?.sessionFile === 'string' ? { sessionFile: request.linkData.sessionFile } : {}) }, request.remoteSessionId, request.signal);
      return { source: { ...resolved.source, sessionFile: file }, remoteSessionId: request.remoteSessionId, linkData: { sessionFile: file } };
    });
  };
  return {
    resolveSource: async request => {
      const failure = getAgentExternalSessionsInvocationFailure(request); if (failure) return failure;
      return guarded(request, async () => {
        const resolved = await resolveCodeBuddySource(request.source, env);
        if (request.includeAccountingSource === false) return { source: resolved.source };
        const inventory = await discoverCodeBuddyFiles(resolved.root, request.signal);
        return { source: resolved.source, accountingSource: { rootPath: resolved.homeDir, rootField: 'homeDir', resourceKey: `codebuddy:${resolved.root}`, changeObservation: 'watch_file_changes' as const,
          watchFileChanges: { files: [...inventory.files], topologyDirectories: [...inventory.topologyDirectories] } } };
      });
    },
    listCandidates: async request => {
      // Scan deadlines yield partial pages; hard invocation cancellation remains final.
      if (request.signal.aborted) return getAgentExternalSessionsInvocationFailure(request)!;
      return guarded(request, () => listCodeBuddyCandidates(request, env));
    },
    resolveLinkIdentity: identity,
    resolveLinkedIdentity: identity,
    pageTranscript: async request => {
      const failure = getAgentExternalSessionsInvocationFailure(request); if (failure) return failure;
      return guarded(request, async () => {
        if (request.direction !== 'older') throw new CodeBuddySourceError('invalid_request', 'CodeBuddy transcript pages use older direction.');
        const resolved = await resolveCodeBuddySource(request.source, env);
        const file = await resolveCodeBuddyFile(resolved.root, resolved.source, request.remoteSessionId, request.signal);
        const page = await pageCodeBuddyTranscript({ ...request, file });
        return { items: page.items, nextCursor: page.nextCursor, tailCursor: page.tailCursor, hasMore: page.nextCursor !== null, ...(page.partial ? { truncated: true, diagnostics: [{ code: 'unsupported_native_record', severity: 'required' as const, count: 1, positions: [] }] } : {}) };
      });
    },
    readAfterTranscript: async request => {
      const failure = getAgentExternalSessionsInvocationFailure(request); if (failure) return failure;
      return guarded(request, async () => {
        const resolved = await resolveCodeBuddySource(request.source, env);
        try {
          const file = await resolveCodeBuddyFile(resolved.root, resolved.source, request.remoteSessionId, request.signal);
          return await readAfterCodeBuddyTranscript({ ...request, file });
        } catch (error) {
          if (error instanceof CodeBuddySourceError && error.code === 'source_unavailable') return { outcome: 'source_unavailable' as const };
          throw error;
        }
      });
    },
  };
}
export const codeBuddyExternalSessionsContribution: AgentExternalSessionsContribution = createCodeBuddyExternalSessionsContribution();
