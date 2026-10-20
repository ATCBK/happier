import axios from 'axios';
import { vi } from 'vitest';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';

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
