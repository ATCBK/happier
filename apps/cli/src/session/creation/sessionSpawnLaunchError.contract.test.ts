import { describe, expect, it } from 'vitest';
import { normalizeSpawnSessionErrorDetail } from '@happier-dev/protocol/spawnSession';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SpawnSessionControlErrorResponseSchema, projectSpawnSessionControlErrorResponse } from '@/session/shared/spawnSessionContract';
import { projectSessionSpawnFailure } from './projectSessionSpawnFailure';

describe('Session launch cause transport', () => {
  it('preserves a typed launch cause through the daemon response and strict public creation result', () => {
    const cause = normalizeSpawnSessionErrorDetail({ kind: 'launch_error', code: 'ACP_CATALOG_UNAVAILABLE',
      message: 'Configured ACP catalog is unavailable: definition-required' });
    expect(cause).toEqual({ kind: 'launch_error', code: 'ACP_CATALOG_UNAVAILABLE',
      message: 'Configured ACP catalog is unavailable: definition-required' });
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse({
      errorCode: 'SPAWN_FAILED', errorMessage: 'Failed to spawn session', errorDetail: cause,
    }));
    expect(response.errorDetail).toEqual(cause);
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }))).toMatchObject({ launchError: cause });
  });

  it('keeps missing Agents typed and gives uncoded failures an explicit cause', () => {
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({ errorCode: 'agent_cli_missing',
      errorMessage: 'Install the selected Agent', agentId: 'custom-acp' }))).toEqual({
      type: 'error', code: 'agent_cli_missing', agentId: 'custom-acp', retryable: false });
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({ errorCode: '', errorMessage: 'Launch refused' })))
      .toMatchObject({ code: 'spawn_failed', launchError: { code: 'SPAWN_FAILED', message: 'Launch refused' } });
    expect(SessionSpawnNewResultV1Schema.safeParse({ type: 'error', code: 'agent_cli_missing',
      agentId: 'custom-acp', retryable: false, launchError: { kind: 'launch_error', code: 'ENOENT', message: 'Missing' } }).success).toBe(false);
  });
});
