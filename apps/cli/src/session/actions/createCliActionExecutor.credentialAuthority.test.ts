import { describe, expect, it } from 'vitest';

import { createCliActionExecutor } from './createCliActionExecutor';

function createExecutor(credentialProvenance: 'api_token' | 'stored_session') {
  const token = credentialProvenance === 'api_token'
    ? 'hap_v1_api-token'
    : 'stored-session-bearer';
  return createCliActionExecutor({
    token,
    credentials: {
      token,
      encryption: null,
      credentialProvenance,
    },
    sessionId: 'sess-1',
    mode: 'plain',
    ctx: null,
    pluginActionExecutionOwner: 'current_process',
  });
}

describe('createCliActionExecutor credential authority', () => {
  it('refuses present-user approval preparation for API-token credentials even with an authority claim', async () => {
    const executor = createExecutor('api_token');
    await expect(executor.prepare('approval.request.decide',
      { artifactId: 'approval-1', decision: 'approve' },
      { surface: 'cli', authority: 'present_user' },
    )).resolves.toMatchObject({
      kind: 'settled', result: { ok: false, errorCode: 'present_user_required' },
    });
    await expect(executor.execute(
      'approval.request.decide',
      { artifactId: 'approval-1', decision: 'approve' },
      { surface: 'cli' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'present_user_required',
      error: 'present_user_required',
    });
  });

  it('keeps an authenticated stored CLI session eligible for present-user actions', async () => {
    const executor = createExecutor('stored_session');
    expect((await executor.prepare('approval.request.decide',
      { artifactId: 'approval-1', decision: 'approve' }, { surface: 'cli' },
    )).kind).toBe('ready');
  });
});
