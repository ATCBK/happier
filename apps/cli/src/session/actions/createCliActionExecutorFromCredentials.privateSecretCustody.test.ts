import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { SavedSecretSchema } from '@happier-dev/protocol';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

describe('CLI private Provider secret custody', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses public-token prepare and execute without disclosing or abandoning private material', async () => {
    // HTTP is the boundary; no Action, policy, placement, or producer is substituted.
    const request = vi.spyOn(axios, 'request').mockRejectedValue(new Error('unexpected_network_effect'));
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('unexpected_network_effect'));
    const get = vi.spyOn(axios, 'get').mockRejectedValue(new Error('unexpected_network_effect'));
    const signal = new AbortController().signal;
    const executor = createCliActionExecutorFromCredentials({
      credentials: { token: 'private-test-token', encryption: null, credentialProvenance: 'api_token' },
      serverId: 'home', serverApiUrl: 'https://home.example.test', machineId: 'machine-a',
      providerPreparedSavedSecret: { id: 'prepared', record: SavedSecretSchema.parse({
        id: 'prepared', name: 'Prompted key', kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'memory-only-key' }, createdAt: 100, updatedAt: 100,
      }) },
      hostActionApprovalLifetime: { actionId: 'providers.connections.secrets.bind', signal },
    });
    const input = { action: 'bindSecret', machineId: 'machine-a', connectionId: 'pc_1',
      credentialSlotId: 'apiKey', scope: 'machine', savedSecretId: 'prepared' };
    const context = { surface: 'cli' as const, signal };
    const refusal = { ok: false, errorCode: 'private_action_preparation_transport_unsupported' };
    await expect(executor.prepare('providers.connections.secrets.bind', input, context))
      .resolves.toMatchObject({ kind: 'settled', result: refusal });
    await expect(executor.execute('providers.connections.secrets.bind', input, context)).resolves.toMatchObject(refusal);
    expect(request).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
