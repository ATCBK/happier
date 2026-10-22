import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { ProviderBrokerRequestAdmissionV1 } from '@happier-dev/protocol';

import { ApiClient } from './api';
import { runWithServerHttpBaseUrl } from './client/serverHttpBaseUrl';

const admission: ProviderBrokerRequestAdmissionV1 = {
  v: 1,
  authority: {
    payload: {
      v: 1, grantId: 'grant-1', aud: 'happier-provider-broker-route-v1', issuedAt: 100, expiresAt: 200,
      teamId: 'team-1', resourceId: 'resource-1', sourceRevision: 'source-revision-1',
      brokerPlacementFingerprint: 'c'.repeat(64), initiatorTokenEpoch: 0,
      initiator: { accountId: 'recipient', machineId: 'worker', endpointId: 'a'.repeat(64) },
      target: { custodianAccountId: 'custodian', machineId: 'broker', endpointId: 'b'.repeat(64) },
      consumer: { kind: 'session', sessionId: 'session-1' },
      application: {
        agentTargetKey: 'codex',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses',
      },
    },
    signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: 'A'.repeat(86) },
  },
  expectedResourceRevision: 0, sourceMemberKey: 'source-member-1', requestId: 'request-1',
  requestFacts: { generation: true, routeKind: 'openai_responses', modelId: 'gpt-5', reasoningEffort: null },
};

describe('Provider broker Home admission request lifetime', () => {
  it('accepts a valid Home response beyond the former ten-second phase cutoff', async () => {
    // Real HTTP/Axios observes the former cutoff; no adapter mock can mask it.
    const home = createServer(async (_request, response) => {
      await delay(10_100);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, reasonCode: 'resource_changed' }));
    });
    home.listen(0, '127.0.0.1');
    await once(home, 'listening');
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('Home fixture not listening');
    const api = await ApiClient.create({ token: 'fixture-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } });
    try {
      await expect(runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () =>
        await api.admitTeamCredentialProviderBrokerRequest(admission, { signal: new AbortController().signal }),
      )).resolves.toEqual({ ok: false, reasonCode: 'resource_changed' });
    } finally {
      home.closeAllConnections();
      await new Promise<void>((resolve, reject) => home.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('cancels a pending Home admission when the containing request is cancelled', async () => {
    const received = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const home = createServer((_request, response) => {
      response.once('close', () => disconnected.resolve());
      received.resolve();
    });
    home.listen(0, '127.0.0.1');
    await once(home, 'listening');
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('Home fixture not listening');
    const api = await ApiClient.create({ token: 'fixture-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } });
    const controller = new AbortController();
    try {
      const pending = runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () =>
        await api.admitTeamCredentialProviderBrokerRequest(admission, { signal: controller.signal }));
      const result = expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
      await received.promise;
      controller.abort();
      await result;
      await disconnected.promise;
    } finally {
      controller.abort();
      home.closeAllConnections();
      await new Promise<void>((resolve, reject) => home.close((error) => error ? reject(error) : resolve()));
    }
  });
});
