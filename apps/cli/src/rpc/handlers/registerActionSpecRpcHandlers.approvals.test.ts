import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { assertActionOutputContract } from '@/testkit/actionOutputContract';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';

// Home HTTP/persistence is the system boundary. Capture opaque bytes from the
// actual Account Artifact producer; never reconstruct approval header/body DTOs.
const artifactCarrier = z.object({ id: z.string(), header: z.string(), body: z.string(),
  dataEncryptionKey: z.string(), provenance: z.string().nullish(), provenanceDataEncryptionKey: z.string().nullish() });

describe('composed approval catalog RPC and Account Artifact transport', () => {
  it('registers real catalog bindings and reads the real producer through executor, HTTP and storage codecs', async () => {
    const home = fastify();
    type StoredRow = z.infer<typeof artifactCarrier> & {
      ownerAccountId: string; access: 'owner'; encryptionMode: 'plain';
      headerVersion: number; bodyVersion: number; seq: number; createdAt: number; updatedAt: number;
    };
    const rows = new Map<string, StoredRow>();
    home.addHook('onRequest', async (request, reply) => {
      if (request.headers.authorization !== 'Bearer approval-account') return reply.code(401).send({ error: 'unauthorized' });
    });
    home.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    home.post('/v1/artifacts', async request => {
      const carrier = artifactCarrier.parse(request.body);
      const row: StoredRow = { ...carrier, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      rows.set(row.id, row);
      return { id: row.id, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion };
    });
    home.get('/v1/artifacts', async () => [...rows.values()]);
    home.get<{ Params: { id: string } }>('/v1/artifacts/:id', async (request, reply) =>
      rows.get(request.params.id) ?? reply.code(404).send({ error: 'not_found' }));
    await home.ready();
    const origin = 'http://approval-catalog.test';
    const restore = installAxiosFastifyAdapter({ app: home, origin });
    try {
      await runWithServerHttpBaseUrl(origin, async () => {
        const store = createCliApprovalsArtifactStore({ credentials: { token: 'approval-account', encryption: null }, serverId: 'home' });
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
          createdBy: { surface: 'system' }, actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        const created = await store.approvalsCreate({ request, serverId: 'home' });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...store });
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {} });
        // No supplied specs/methods: registration must consume the real catalog.
        registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: executor,
          actionIds: ['approval.request.list', 'approval.request.get'] });

        const listed = await rpc.invokeLocal('approval.request.list', { status: 'open', limit: 5, serverId: 'home' });
        assertActionOutputContract('approval.request.list', listed);
        expect(listed).toMatchObject({ items: [{ artifactId: created.artifactId, status: 'open', actionId: 'session.list', serverId: 'home' }],
          queryPlan: { backingStore: 'ArtifactStore', hydratedTranscripts: false } });
        const read = await rpc.invokeLocal('approval.request.get', { artifactId: created.artifactId, serverId: 'home' });
        assertActionOutputContract('approval.request.get', read);
        expect(read).toMatchObject({ artifactId: created.artifactId, request });
        await expect(rpc.invokeLocal('approval.request.get', { artifactId: created.artifactId, serverId: 'other-home' }))
          .resolves.toMatchObject({ ok: false, errorCode: 'approval_not_found' });
        await expect(rpc.invokeLocal('approval.request.list', { status: 'approved', limit: 5, serverId: 'home' }))
          .resolves.toMatchObject({ items: [] });

        // Wiring sensitivity: the same production registrar with the store
        // omitted must refuse; a canned result or mocked executor cannot mask it.
        const unbound = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {} });
        registerActionSpecRpcHandlers({ rpcHandlerManager: unbound,
          actionExecutor: createActionExecutor(createUnavailableActionTransportDeps()), actionIds: ['approval.request.list'] });
        await expect(unbound.invokeLocal('approval.request.list', { status: 'open', limit: 5, serverId: 'home' }))
          .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
      });
    } finally {
      restore();
      await home.close();
    }
  });
});
