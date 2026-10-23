import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeWorkspaceSyncPolicyDigest, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ProjectAccountRowV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { logger } from '@/ui/logger';
import { composeBindChildSourcePhaseTestRuntime } from './createProductionDaemonWorkspaceSyncRuntime.testkit';

const socketIo = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', async importOriginal => {
  const actual = await importOriginal<typeof import('socket.io-client')>();
  return { ...actual, io: (...args: Parameters<typeof actual.io>) =>
    typeof args[0] === 'string' && args[0].startsWith('http://127.0.0.1:')
      ? actual.io(...args) : socketIo(...args) };
});

const contentPolicyInput = { v: 1 as const, selection: 'all_files' as const,
  extraIgnorePatterns: [], extraIncludePatterns: [] };
const contentPolicy = { ...contentPolicyInput, policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicyInput) };

// Real requester observation keeps process-scoped custody. Isolate it from the
// older ambient-custodian fixtures so their socket stubs cannot share that state.
describe('signed Project clean preparation', () => {
  it('dispatches Project clean preparation from one fresh route read per handoff', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    onTestFinished(async () => await channel.close());
    const rows: ProjectAccountRowV1[] = [];
    let rowReads = 0;
    const deliveries: unknown[] = [];
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo,
      readAdditionalHttpResponse: async url => url.endsWith('/v1/account/encryption/currentness')
        ? { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }
        : url.endsWith('/v1/account/profile')
        ? { status: 200, data: { id: 'owner' } }
        : url.endsWith('/v2/account/settings')
          ? { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } } : undefined,
      readAdditionalHttpPostResponse: async url => {
        if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
        if (!url.endsWith('/project-rows/list')) return undefined;
        rowReads += 1;
        return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      },
      // Signed Machine delivery is the network boundary. Route admission,
      // requester custody, row decoding and the result schema stay real.
      callWorkspacePrepareBetween: async descriptor => {
        deliveries.push(descriptor);
        return { ok: true, traversed: [] };
      },
    });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    for (const value of [fixture.sourceRef, fixture.targetRef]) {
      const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: value.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    const key = { kind: 'relationship-graph' as const };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: { relationships: [{
      v: 1, relationshipId: 'requester-clean', controllerMachineId: fixture.sourceRef.machineId,
      alphaWorkspaceRefId: fixture.sourceRef.id, betaWorkspaceRefId: fixture.targetRef.id,
      mode: 'keep_both_in_sync', contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1,
    }] } }) }));
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'causal-clean',
      target: { kind: 'machine', machineId: fixture.targetRef.machineId }, input: {
        workspace: { serverId: fixture.serverId, machineId: fixture.sourceRef.machineId,
          workspaceId: fixture.sourceRef.id, rootPath: fixture.sourceRef.rootPath }, selection: { kind: 'named', name: 'test' },
      } });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-project-proof', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: fixture.managedHomeId,
      machineId: fixture.targetRef.machineId, custodianAccountId: 'owner', installationId: 'parent-installation',
      actionId: 'projects.script.run', requestId: envelope.requestId, target: envelope.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), accountEncryptionMode: 'plain',
    } });
    let current = true;
    const diagnostics = vi.spyOn(logger, 'warnLocalFile');
    onTestFinished(() => diagnostics.mockRestore());
    const admitted = await admitRequesterAccountActionContext({ authorization, credentials: fixture.credentials,
      serverId: fixture.serverId, serverIdentityId: fixture.managedHomeId,
      serverHttpBaseUrl: 'https://bind-child-home.invalid', isCurrent: async () => current });
    if (!admitted) throw new Error(`Requester custody was not admitted: ${JSON.stringify(diagnostics.mock.calls)}`);
    onTestFinished(async () => await admitted.dispose());
    const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
      serverId: fixture.serverId, serverIdentityId: fixture.managedHomeId,
      serverHttpBaseUrl: 'https://bind-child-home.invalid', target: authorization.binding.target,
      installationId: 'parent-installation', privateKey: tweetnacl.sign.keyPair().secretKey, isCurrent: admitted.isCurrent });
    if (!carrier) throw new Error('Requester HTTP custody was not admitted');
    const context: RpcHandlerContext = { signal: new AbortController().signal, originalActionEnvelope: envelope,
      callerInputAuthorization: carrier, verifyMachineAdmissionCurrent: async () => current,
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: fixture.targetRef.machineId,
        installationId: 'parent-installation', role: 'manage', encryptionMode: 'plain' } };
    const request = { sourceWorkspaceRefId: fixture.sourceRef.id, targetWorkspaceRefId: fixture.targetRef.id };
    for (let invocation = 0; invocation < 2; invocation += 1) {
      rowReads = 0;
      await expect(fixture.child.handoffAdapter.prepareBetween(request, context.signal, context))
        .resolves.toEqual({ ok: true, traversed: [] });
      expect.soft(rowReads).toBe(1);
    }
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({ machineId: fixture.sourceRef.machineId, sourceWorkspace: fixture.sourceRef, request });
    current = false;
    await expect(fixture.child.handoffAdapter.prepareBetween(request, context.signal, context))
      .rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
    expect(deliveries).toHaveLength(2);
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  });

});
