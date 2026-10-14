import axios from 'axios';
import { vi } from 'vitest';
import { ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowV1Schema,
  type ProjectAccountRowKeyV1, type ProjectAccountRowMutationRequestV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

export function createPlainProjectAccountRefRow(ref: WorkspaceRefV1, revision = 0) {
  const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
  return ProjectAccountRowV1Schema.parse({ key, revision, content: { t: 'plain', v: { key, value: ref } } });
}

/** Account HTTP is the system boundary; real CLI row/graph admission runs beneath this adapter. */
export function mockProjectAccountRowsHttpBoundary(rows: unknown[], options: Readonly<{
  beforeMutation?: (request: ProjectAccountRowMutationRequestV1) => void;
}> = {}) {
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
  const indexFor = (key: ProjectAccountRowKeyV1) => rows.findIndex(row => row !== null && typeof row === 'object'
    && JSON.stringify(Reflect.get(row, 'key')) === JSON.stringify(key));
  return vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
    const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
    options.beforeMutation?.(request);
    // The transport's revision assertions settle atomically, including retained tombstones.
    for (const assertion of [...request.mutations, ...request.expectedRefs]) {
      const index = indexFor(assertion.key);
      const revision = index < 0 ? -1 : ProjectAccountRowV1Schema.parse(rows[index]).revision;
      if (revision !== (assertion.expectedRevision === 'absent' ? -1 : assertion.expectedRevision)) {
        return { status: 200, data: { status: 'conflict', key: assertion.key, revision } };
      }
    }
    const acknowledged = request.mutations.map(mutation => ({ key: mutation.key,
      revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content }));
    for (const row of acknowledged) {
      const index = indexFor(row.key);
      if (index < 0) rows.push(row); else rows[index] = row;
    }
    return { status: 200, data: { status: 'updated', rows: acknowledged, cursor: 1 } };
  });
}
