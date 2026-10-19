import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { vi } from 'vitest';

// Schema-shaped synthetic HTTP fixtures, not tenant captures.
// https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql
// https://linear.app/developers/{filtering,pagination,rate-limiting}
export const account = { service: { pluginId: 'happier.linear', localId: 'linear-account' }, accountId: 'linear-test' };
export const instance = {
  v: 1 as const, instance: { source: { pluginId: 'happier.linear', localId: 'linear-issues' }, sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
  binding: { purpose: 'linear-api', account }, localInstanceKey: 'linear/team-1',
  configuration: { v: 1 as const, token: JSON.stringify({ v: 1, teamId: 'team-1', involvement: 'mine' }) },
};
export const localRef = { kindId: 'issue', collisionScope: 'linear', entryId: 'issue-1' };
export const issue = {
  id: 'issue-1', identifier: 'ENG-123', title: 'Keep the source authoritative', url: 'https://linear.app/example/issue/ENG-123',
  createdAt: '2026-10-17T09:00:00.000Z', updatedAt: '2026-10-18T09:00:00.000Z',
  team: { id: 'team-1', name: 'Engineering', key: 'ENG' }, state: { id: 'state-1', name: 'In Progress', type: 'started' },
  priority: 2, priorityLabel: 'High', assignee: { id: 'viewer-1', name: 'Mara' }, creator: { id: 'viewer-1', name: 'Mara' },
  project: { id: 'project-1', name: 'Autumn' }, cycle: { id: 'cycle-1', name: 'October', number: 12 },
  dueDate: '2026-10-25', estimate: 3, parent: { id: 'parent-1', identifier: 'ENG-100', title: 'Parent' },
  subscribers: { nodes: [{ id: 'viewer-1' }] },
};
export const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
export function host(answer: (request: { query: string; variables: Record<string, unknown>; operationName: string }) => unknown) {
  const request = vi.fn(async (input: { url: string; body?: Uint8Array }, options?: { signal?: AbortSignal }) => {
    options?.signal?.throwIfAborted();
    const query = JSON.parse(new TextDecoder().decode(input.body));
    const data = answer(query);
    return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify({ data })) };
  });
  const materializeListedAccount = vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { authorization: 'test-personal-key' } }));
  // Only the genuine host HTTP/credential boundaries are replaced.
  const context = { signal: new AbortController().signal, services: { http: { request }, connectedAccounts: {
    listAccounts: async () => ({ status: 'complete', accounts: [{ account, state: 'connected', connectedAccountOrigins: ['https://api.linear.app'] }] }),
    getBinding: async () => null, materializeListedAccount,
  } } } as unknown as PluginInvocationContext;
  return { context, request, materializeListedAccount };
}
