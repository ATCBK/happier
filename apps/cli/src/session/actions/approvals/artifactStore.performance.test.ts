import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { expect, it } from 'vitest';
import { ApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliApprovalsArtifactStore } from './artifactStore';

it('reads fresh encrypted approval decisions without invoking recipient repair', async () => {
  const machineKey = new Uint8Array(randomBytes(32));
  const credentials = { token: 'synthetic-token', encryption: { type: 'dataKey' as const,
    machineKey, publicKey: x25519.getPublicKey(machineKey) } };
  const resource = await createResourceDataKey({ credentials, mode: 'e2ee' });
  if (resource.mode !== 'e2ee') throw new Error('Missing encrypted fixture');
  const request = ApprovalRequestV1Schema.parse({ v: 1, actionId: 'session.title.set', status: 'open',
    summary: 'Change title', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'cli', sessionId: 'session' },
    actionArgs: { sessionId: 'session', title: 'Reviewed title' } });
  const seal = (value: unknown) => encodeBase64(encryptWithDataKey(value, resource.dataKey), 'base64');
  let rawReads = 0;
  let censusReads = 0;
  let summary = request.summary;
  const home = createServer((req, response) => {
    response.setHeader('Content-Type', 'application/json');
    // Real HTTP is the only substituted system boundary; codecs, approval
    // projection and the Account Artifact reader all run unchanged.
    setTimeout(() => {
      if (req.url === '/v1/artifacts/approval') {
        rawReads++;
        const current = { ...request, summary };
        response.end(JSON.stringify({ id: 'approval', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
          dataEncryptionKey: resource.dataEncryptionKey, header: seal(buildApprovalRequestArtifactHeaderV1(current)),
          body: seal({ body: JSON.stringify(current) }), headerVersion: rawReads, bodyVersion: rawReads,
          seq: 1, createdAt: 1, updatedAt: 1 }));
      } else if (req.url === '/v1/artifacts/approval/access/recipients') {
        censusReads++;
        response.end(JSON.stringify({ artifactId: 'approval', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
          dataEncryptionKey: resource.dataEncryptionKey, callerDataEncryptionKey: resource.dataEncryptionKey, recipients: [] }));
      } else { response.statusCode = 404; response.end('{}'); }
    }, 20);
  });
  await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
  const address = home.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture HTTP address');
  try {
    await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
      const store = createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
      for (let sample = 0; sample < 3; sample++) {
        summary = `Review ${sample}`;
        expect(await store.approvalsGet({ artifactId: 'approval', serverId: null })).toMatchObject({ summary });
      }
      expect({ rawReads, censusReads }).toEqual({ rawReads: 3, censusReads: 0 });
    });
  } finally {
    home.closeAllConnections();
    await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
  }
});
