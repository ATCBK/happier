import { executeInternalTaskAction } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import type { InternalTaskActionId, InternalTaskListOutput, InternalTaskMutationOutput } from '@happier-dev/protocol/actions/internalTaskActions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createTodoAccountKvTransport } from '@/sync/domains/todos/todoAccountKvTransport';
import { serverFetch, type ServerFetch } from '@/sync/http/client';
import { sync } from '@/sync/sync';
import { parseToken } from '@/utils/auth/parseToken';
import { randomUUID } from '@/platform/randomUUID';

export async function executeInternalTaskHostAction(args: Readonly<{
  actionId: InternalTaskActionId; input: unknown; signal?: AbortSignal;
}>): Promise<InternalTaskListOutput | InternalTaskMutationOutput> {
  const lifetime = captureActiveServerAccountScopeLifetime();
  const credentials = sync?.getCredentials();
  if (!lifetime || !credentials) return { status: 'unavailable' };
  const snapshot = getActiveServerSnapshot();
  const requireCurrent = () => {
    if (args.signal?.aborted || !lifetime.isCurrent() || snapshot.serverId !== lifetime.scope.serverId
      || sync?.getCredentials()?.token !== credentials.token || parseToken(credentials.token) !== lifetime.scope.accountId) {
      throw Object.assign(new Error('task_scope_mismatch'), { code: 'task_scope_mismatch' });
    }
  };
  const request: ServerFetch = (path, init, options) => {
    requireCurrent();
    return serverFetch(path, { ...init, ...(args.signal ? { signal: args.signal } : {}) }, {
      ...options, expectedActiveServer: { serverId: snapshot.serverId, generation: snapshot.generation },
    });
  };
  return executeInternalTaskAction({ ...args, scope: lifetime.scope, requireCurrent, createId: randomUUID,
    port: createTodoAccountKvTransport({ credentials, request, requireCurrent }),
  });
}
