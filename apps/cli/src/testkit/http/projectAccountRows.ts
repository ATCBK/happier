import axios from 'axios';
import { vi } from 'vitest';
import {
  PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema, ProjectAccountRowReadRequestV1Schema,
  ProjectAccountRowReadResponseV1Schema, buildProjectAccountRowPhysicalKeyV1,
  type ProjectAccountRowReadResponseV1, type ProjectAccountRowV1,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';

/** Home is the boundary; keep exact-checkout resolution real for unassociated test directories. */
export function installEmptyProjectAccountRowsHttpBoundary(): () => void {
  const mode = vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (!url.endsWith('/v1/account/encryption')) throw new Error(`Unexpected Account GET ${url}`);
    return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
  });
  const rows = vi.spyOn(axios, 'post').mockImplementation(async url => {
    if (!url.endsWith(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`)) throw new Error(`Unexpected Account POST ${url}`);
    return { status: 200, data: ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] }) };
  });
  return () => { rows.mockRestore(); mode.mockRestore(); };
}

/** Home's exact-row read: the organization CAS and other selected reads ask for one key, never the census. */
export function projectAccountRowReadResponse(
  rows: readonly ProjectAccountRowV1[], body: unknown,
): Readonly<{ status: 200; data: ProjectAccountRowReadResponseV1 }> {
  const { key } = ProjectAccountRowReadRequestV1Schema.parse(body);
  const identity = buildProjectAccountRowPhysicalKeyV1(key);
  const row = rows.find(candidate => buildProjectAccountRowPhysicalKeyV1(candidate.key) === identity);
  return { status: 200, data: ProjectAccountRowReadResponseV1Schema.parse(!row ? { status: 'absent' }
    : row.content === null ? { status: 'deleted', revision: row.revision } : { status: 'present', row }) };
}
