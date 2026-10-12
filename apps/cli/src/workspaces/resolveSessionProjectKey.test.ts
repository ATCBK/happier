import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { withdrawActiveProjectAccountRowsSnapshot } from './projectAccountRows';
import { resolveSessionProjectKey } from './resolveSessionProjectKey';

const serverId = 'association-home';
const input = { credentials: { token: 'association-token', encryption: null }, serverId, machineId: 'machine', directory: '/repo',
  metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' } };
const workspaceRef = { id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 };
function readRows() {
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
  const key = { kind: 'workspace-ref', serverId, id: workspaceRef.id };
  return vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
    { key, revision: 1, content: { t: 'plain', v: { key, value: workspaceRef } } },
  ] } });
}
afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); });
it('resolves the exact Account workspace reference and Project key', async () => {
  readRows();
  await expect(resolveSessionProjectKey(input)).resolves.toMatchObject({ kind: 'resolved', projectKey: 'project', workspaceRef });
});
it('returns none for unassociated metadata without reading the Account', async () => {
  const request = readRows();
  await expect(resolveSessionProjectKey({ ...input, metadata: {} })).resolves.toEqual({ kind: 'none' });
  expect(request).not.toHaveBeenCalled();
});
it.each([{ projectId: 'project' }, { workspaceId: 'checkout', projectId: 'other' },
  { workspaceId: 'missing', projectId: 'project' }])('keeps incomplete or mismatched association pending: %j', async metadata => {
  readRows();
  await expect(resolveSessionProjectKey({ ...input, metadata })).resolves.toEqual({ kind: 'pending', reason: 'project_association_unavailable' });
});
it('does not treat an unreadable Account association as none', async () => {
  readRows().mockRejectedValue(new Error('network_unavailable'));
  await expect(resolveSessionProjectKey(input)).resolves.toEqual({ kind: 'pending', reason: 'project_association_unavailable' });
});
it('preserves cancellation rather than converting it to pending', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  readRows().mockImplementation(async () => { controller.abort(reason); throw reason; });
  await expect(resolveSessionProjectKey({ ...input, signal: controller.signal })).rejects.toBe(reason);
});
