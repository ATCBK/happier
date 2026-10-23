import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeWorkspaceSyncPolicyDigest, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ProjectAccountRowV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkspaceSyncSourceRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { logger } from '@/ui/logger';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
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
  it('uses one fresh route read per handoff and receiving preparation, including repeated invocations', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    onTestFinished(async () => await channel.close());
    const rows: ProjectAccountRowV1[] = [];
    let readRows = async () => rows;
    let rowReads = 0;
    let current = true;
    let revokeOnMachineRead = false;
    let changeRowsOnMachineRead: (() => void) | undefined;
    const deliveries: unknown[] = [];
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      readAdditionalHttpResponse: async url => {
        if (changeRowsOnMachineRead && url.includes('/v1/machines/')) {
          const change = changeRowsOnMachineRead;
          changeRowsOnMachineRead = undefined;
          change();
        }
        if (revokeOnMachineRead && url.includes('/v1/machines/')) {
          revokeOnMachineRead = false;
          current = false;
        }
        return url.endsWith('/v1/account/encryption/currentness')
        ? { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }
        : url.endsWith('/v1/account/profile')
        ? { status: 200, data: { id: 'owner' } }
        : url.endsWith('/v2/account/settings')
          ? { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } } : undefined;
      },
      readAdditionalHttpPostResponse: async url => {
        if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
        if (!url.endsWith('/project-rows/list')) return undefined;
        rowReads += 1;
        return { status: 200, data: { status: 'listed', coverage: 'complete', rows: await readRows() } };
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
    const relationship = {
      v: 1 as const, relationshipId: 'requester-clean', controllerMachineId: fixture.sourceRef.machineId,
      alphaWorkspaceRefId: fixture.sourceRef.id, betaWorkspaceRefId: fixture.targetRef.id,
      mode: 'keep_both_in_sync' as const, contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1,
    };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0,
      content: cipher.seal({ key, value: { relationships: [relationship] } }) }));
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
    await mkdir(fixture.targetPath, { recursive: true });
    const graphIndex = rows.findIndex(row => row.key.kind === 'relationship-graph');
    const refreshRelationship = async (enabled: boolean, revision: number) => {
      rows[graphIndex] = ProjectAccountRowV1Schema.parse({ key, revision,
        content: cipher.seal({ key, value: { relationships: [{ ...relationship, enabled }] } }) });
      await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
        credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed',
      }));
      await fixture.settleProjects();
    };
    // Establish real target bootstrap custody before enabling the retained link.
    await refreshRelationship(false, 0);
    await fixture.parentManagedWorkspaceSync.ensure(relationship, undefined,
      { transient: true, targetBootstrap: 'use_existing' });
    await refreshRelationship(true, 1);
    const receiver = fixture.parentRpcHandlers.get('daemon.workspaceSync.prepareBetween.v1');
    if (!receiver) throw new Error('Production preparation receiver is unavailable');
    const receivingContext: RpcHandlerContext = { ...context,
      workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare',
        operationId: envelope.requestId, accountServerId: fixture.serverId,
        sourceMachineId: fixture.sourceRef.machineId, sourceRootPath: fixture.sourceRef.rootPath,
        originalActionEnvelope: envelope }) };
    for (let invocation = 0; invocation < 2; invocation += 1) {
      const payload = `source edit at dequeue ${invocation}`;
      await writeFile(join(fixture.sourcePath, 'payload.txt'), payload);
      rowReads = 0;
      await expect(receiver(request, receivingContext)).resolves.toMatchObject({ ok: true,
        traversed: [{ relationshipId: 'requester-clean' }] });
      expect.soft(rowReads).toBe(2);
      expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe(payload);
    }
    rowReads = 0;
    await expect(fixture.parent.handoffAdapter.prepareBetween(request, context.signal, receivingContext))
      .resolves.toMatchObject({ ok: true, traversed: [{ relationshipId: 'requester-clean' }] });
    expect(rowReads).toBe(2);

    // A requester-private row can change after admission without updating the
    // daemon's installed Account projection before its queued physical copy.
    for (const changeKind of ['disabled relationship', 'changed endpoint'] as const) {
      const acceptedRows = [...rows];
      const beforeWithdrawal = await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8');
      await writeFile(join(fixture.sourcePath, 'payload.txt'), `${changeKind} must not copy`);
      changeRowsOnMachineRead = () => {
        rows[graphIndex] = ProjectAccountRowV1Schema.parse({ key, revision: 2,
          content: cipher.seal({ key, value: { relationships: [{ ...relationship,
            enabled: changeKind !== 'disabled relationship' }] } }) });
        if (changeKind === 'changed endpoint') {
          const refKey = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.targetRef.id };
          const refIndex = rows.findIndex(row => row.key.kind === 'workspace-ref' && row.key.id === fixture.targetRef.id);
          rows[refIndex] = ProjectAccountRowV1Schema.parse({ key: refKey, revision: 1,
            content: cipher.seal({ key: refKey, value: { ...fixture.targetRef,
              rootPath: join(fixture.targetPath, 'rebound') } }) });
        }
      };
      await expect.soft(receiver(request, receivingContext), changeKind).resolves.toMatchObject({ ok: false,
        errorCode: 'relationship_changed', completed: [] });
      expect.soft(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8'), changeKind).toBe(beforeWithdrawal);
      rows.splice(0, rows.length, ...acceptedRows);
    }

    // A later link must refresh after the first physical copy. Withdraw that
    // later link at the HTTP boundary once the real OS-copy boundary completed.
    const laterRef = { ...fixture.targetRef, id: 'later-ref', rootPath: join(fixture.targetPath, 'later') };
    const laterKey = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: laterRef.id };
    const laterRow = ProjectAccountRowV1Schema.parse({ key: laterKey, revision: 0,
      content: cipher.seal({ key: laterKey, value: laterRef }) });
    const laterLink = { ...relationship, relationshipId: 'later-link',
      betaWorkspaceRefId: laterRef.id };
    const laterEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ ...envelope, requestId: 'two-link-clean', input: {
      workspace: { serverId: fixture.serverId, machineId: fixture.targetRef.machineId,
        workspaceId: fixture.targetRef.id, rootPath: fixture.targetRef.rootPath }, selection: { kind: 'named', name: 'test' },
    } });
    const laterAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
      binding: { ...authorization.binding, requestId: laterEnvelope.requestId,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(laterEnvelope) } });
    const laterAdmitted = await admitRequesterAccountActionContext({ authorization: laterAuthorization,
      credentials: fixture.credentials, serverId: fixture.serverId, serverIdentityId: fixture.managedHomeId,
      serverHttpBaseUrl: 'https://bind-child-home.invalid', isCurrent: async () => current });
    if (!laterAdmitted) throw new Error('Two-link requester custody was not admitted');
    onTestFinished(async () => await laterAdmitted.dispose());
    const laterContext: RpcHandlerContext = { ...receivingContext, callerInputAuthorization: laterAdmitted.authorization,
      originalActionEnvelope: laterEnvelope,
      workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({ ...receivingContext.workspaceSyncSourceRouting,
        operationId: laterEnvelope.requestId, sourceMachineId: fixture.targetRef.machineId,
        sourceRootPath: fixture.targetRef.rootPath, originalActionEnvelope: laterEnvelope }) };
    const copiedPayload = 'first link completed before later link changed';
    await writeFile(join(fixture.sourcePath, 'payload.txt'), copiedPayload);
    readRows = async () => [...rows.filter(row => row.key.kind !== 'relationship-graph'), laterRow,
      ProjectAccountRowV1Schema.parse({ key, revision: 2, content: cipher.seal({ key, value: { relationships:
        await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8') === copiedPayload
          ? [relationship] : [relationship, laterLink] } }) })];
    rowReads = 0;
    await expect(receiver({ sourceWorkspaceRefId: fixture.targetRef.id, targetWorkspaceRefId: laterRef.id }, laterContext))
      .resolves.toMatchObject({ ok: false, errorCode: 'relationship_changed',
        completed: [{ relationshipId: relationship.relationshipId }] });
    expect(rowReads).toBe(3);
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe(copiedPayload);
    readRows = async () => rows;

    // Revocation after route admission is refused by the first link's fresh
    // route read, before any native effect.
    await writeFile(join(fixture.sourcePath, 'payload.txt'), 'revoked edit must not copy');
    revokeOnMachineRead = true;
    await expect(receiver(request, receivingContext)).rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
    current = false;
    await expect(fixture.child.handoffAdapter.prepareBetween(request, context.signal, context))
      .rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
    expect(deliveries).toHaveLength(2);
    await expect(receiver(request, receivingContext)).rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe(copiedPayload);
  });

});
