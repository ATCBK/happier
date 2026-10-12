import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { FilesystemWriteFileInputSchema, FILESYSTEM_MUTATION_ACTION_IDS } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { ApprovalRequestV2Schema, requiresExactDaemonApprovalReplay, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { executeFilesystemMutationAction } from '@/rpc/handlers/fileSystem/pathMutationHandlers';
import { writeFileForRpc } from '@/rpc/handlers/fileSystem/writeFileForRpc';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { executeExternalAction } from './executeExternalAction';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { registerMachineRpcHandlers } from '@/api/machine/rpcHandlers';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExternalActionExecutionResultV1Schema } from '@happier-dev/protocol/actions/externalActionApi';

describe('Machine filesystem approval continuity from UI and paired terminal', () => {
  it.each([
    { actionId: 'daemon.filesystem.createDirectory', surface: 'ui' },
    { actionId: 'daemon.filesystem.rename', surface: 'cli' },
    { actionId: 'daemon.filesystem.delete', surface: 'ui' },
    { actionId: 'daemon.filesystem.writeFile', surface: 'cli' },
    { actionId: 'daemon.filesystem.copy', surface: 'cli' },
    { actionId: 'projects.open', surface: 'cli' },
    { actionId: 'daemon.filesystem.createDirectory', surface: 'rpc' },
    { actionId: 'daemon.filesystem.rename', surface: 'rpc' },
    { actionId: 'daemon.filesystem.delete', surface: 'rpc' },
    { actionId: 'daemon.filesystem.writeFile', surface: 'rpc' },
    { actionId: 'projects.open', surface: 'ui' },
    { actionId: 'daemon.filesystem.writeFile', surface: 'rpc', decision: 'reject' },
    { actionId: 'daemon.filesystem.writeFile', surface: 'rpc', decision: 'cancel' },
    { actionId: 'daemon.filesystem.writeFile', surface: 'cli', decision: 'reject' },
    { actionId: 'daemon.filesystem.writeFile', surface: 'cli', decision: 'cancel' },
  ] as const)('retains exact $actionId from $surface through the human decision $decision', async scenario => {
    const { actionId, surface } = scenario;
    const decision = 'decision' in scenario ? scenario.decision : 'approve';
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-terminal-approval-'));
    const bytes = Buffer.from([0, 255, 128, 10]);
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const principal = { accountId: 'account', authority: 'account_automation' as const,
      authentication: { kind: 'terminal' as const, tokenEpoch: 1 } };
    const input = actionId === 'projects.open' ? { serverId: 'profile', machineId: target.machineId,
      source: { kind: 'folder' as const, path: rootPath }, materialization: { kind: 'attach' as const } }
      : actionId === 'daemon.filesystem.copy' ? { rootPath, from: 'original', to: 'copy', overwrite: false, recursive: false }
      : actionId === 'daemon.filesystem.rename' ? { rootPath, from: 'original', to: 'renamed', overwrite: false }
      : actionId === 'daemon.filesystem.delete' ? { rootPath, path: 'original', recursive: false }
      : actionId === 'daemon.filesystem.writeFile' ? { rootPath, path: 'binary', content: bytes.toString('base64'), expectedHash: null }
      : { rootPath, path: 'folder' };
    const envelope = { v: 1 as const, requestId: 'original-request', target, input };
    const authorization = { v: 1 as const, token: 'verified-home-root', binding: {
      accountId: principal.accountId, authentication: principal.authentication, serverIdentityId: 'home',
      machineId: target.machineId, custodianAccountId: principal.accountId, installationId: 'installation',
      actionId, requestId: envelope.requestId, target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } };
    let stored: ApprovalRequest | null = null;
    let effects = 0;
    const coordinator = createBlockingApprovalCoordinator();
    const filesystem = { workingDirectory: rootPath, accessPolicy: { kind: 'osUser' as const },
      getAdditionalAllowedReadDirs: () => [], getAdditionalAllowedWriteDirs: () => [] };
    // The durable Artifact and authenticated Home are system boundaries. The
    // origin codec, decision/CAS owner, signature and native filesystem stay real.
    const approvalDeps = {
      approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'own-approval' }; },
      approvalsGet: async () => stored,
      approvalsWaitForDecision: coordinator.waitForDecision,
      approvalsResolveBlockingDecision: coordinator.resolveBlockingDecision,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing approval');
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return transition;
        stored = request;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
        accountId: principal.accountId, machineId: target.machineId, serverId: 'profile',
        resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: target.machineId, serverIdentityId: 'home' }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture-account' } }),
        listAccountApiTokens: async () => ({ tokens: [] }), externalActionMachinePublicKey: installation.publicKey,
        verifyExternalExecutionAuthorization: async () => true,
      }),
    } satisfies Pick<import('@happier-dev/protocol').ActionExecutorDeps,
      'approvalsCreate' | 'approvalsGet' | 'approvalsWaitForDecision' | 'approvalsResolveBlockingDecision'
      | 'approvalsUpdate' | 'isApprovalExecutionOriginCurrent'>;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...approvalDeps,
      // Project Open crosses a Machine RPC boundary; native folder materialization
      // has separate owner coverage. Assert the accepted result and exact operands.
      projectsOpen: async request => {
        expect(request).toEqual(input);
        effects += 1;
        return { kind: 'opened', workspace: { serverId: 'profile', machineId: target.machineId,
          workspaceId: 'accepted-workspace', rootPath }, directory: rootPath, setup: 'prepared' };
      },
      filesystemActionExecute: async request => {
        effects += 1;
        if (request.actionId === 'daemon.filesystem.writeFile') return await writeFileForRpc(
          FilesystemWriteFileInputSchema.parse(request.input), filesystem);
        const mutation = FILESYSTEM_MUTATION_ACTION_IDS.find(id => id === request.actionId);
        if (!mutation) throw new Error('Unexpected filesystem effect');
        return await executeFilesystemMutationAction({ ...filesystem, actionId: mutation, input: request.input });
      },
    });
    const rpc = new RpcHandlerManager({ scopePrefix: target.machineId, encryptionMode: 'plain', logger: () => {} });
    // Actual Machine registration selects the installed daemon owner, while
    // the independent deciding client has only Artifact custody and RPC transport.
    const registration = registerMachineRpcHandlers({
      rpcHandlerManager: rpc,
      handlers: { spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'unused' }),
        stopSession: async () => true, requestShutdown() {} },
      deps: { currentMachineId: target.machineId, currentServerId: 'profile', externalAction: {
        machineId: target.machineId, currentServerId: 'profile', resolveAccountId: async () => principal.accountId,
        resolveInstallationId: () => 'installation', verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture-account' } }), executor,
      } },
    });
    const decidingExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...approvalDeps,
      approvalRequestApprovedReplay: async ({ artifactId }) => {
        return ExternalActionExecutionResultV1Schema.parse(await rpc.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, { artifactId }));
      },
    });
    try {
      await writeFile(join(rootPath, 'original'), bytes);
      const invocation = surface === 'rpc' ? executor.execute(actionId, input, {
        surface, authority: 'present_user', serverId: 'profile', serverIdentityId: 'home',
        runtimeAccountId: principal.accountId, actionRequestId: envelope.requestId,
        externalActionTarget: target, defaultSessionMachineId: target.machineId,
      }).then(execution => ({ kind: 'response' as const, response: { execution } }))
        : executeExternalAction({ actionId, envelope, principal, surface,
        executionAuthorization: authorization, currentMachineId: target.machineId, currentServerId: 'profile',
        currentInstallationId: 'installation', externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture-account' } }), executor,
      });
      if (actionId === 'daemon.filesystem.copy') {
        await vi.waitFor(() => expect(coordinator.getLiveWaiterCount('own-approval')).toBe(1));
      } else {
        const pending = await invocation;
        expect(pending, JSON.stringify(pending)).toMatchObject({ kind: 'response', response: { execution: {
          ok: true, result: { kind: 'approval_request_created', artifactId: 'own-approval', actionId },
        } } });
      }
      const request = ApprovalRequestV2Schema.parse(stored);
      expect(request).toMatchObject({ status: 'open', actionArgs: input, executionOriginV1: {
        authority: surface === 'rpc' ? 'present_user' : 'account_automation',
        accountId: principal.accountId, requestId: envelope.requestId,
        ...(surface === 'rpc' ? { surface: 'rpc' }
          : { externalActionExecutionAuthorization: { binding: { authentication: principal.authentication } } }),
      } });
      expect(requiresExactDaemonApprovalReplay(request)).toBe(true);
      expect(effects).toBe(0);
      expect(await readdir(rootPath)).toEqual(['original']);
      expect(await readFile(join(rootPath, 'original'))).toEqual(bytes);
      expect(await decidingExecutor.execute('approval.request.decide', { artifactId: 'own-approval', decision: 'approve' }, {
        surface: 'ui', authority: 'account_automation',
      })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(effects).toBe(0);
      if (decision !== 'approve') {
        expect(await decidingExecutor.execute('approval.request.decide', { artifactId: 'own-approval', decision }, {
          surface: 'ui', authority: 'present_user',
        })).toMatchObject({ ok: true, result: { status: decision === 'reject' ? 'rejected' : 'canceled' } });
        expect(await rpc.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, { artifactId: 'own-approval' }))
          .toMatchObject({ ok: false, errorCode: 'approval_not_approved' });
        expect(effects).toBe(0);
        expect(await readdir(rootPath)).toEqual(['original']);
        expect(await readFile(join(rootPath, 'original'))).toEqual(bytes);
        return;
      }
      const humanDecision = await decidingExecutor.execute('approval.request.decide', { artifactId: 'own-approval', decision: 'approve' }, {
        surface: 'ui', authority: 'present_user',
      });
      expect(humanDecision, JSON.stringify(humanDecision)).toMatchObject({ ok: true,
        result: { status: actionId === 'daemon.filesystem.copy' ? 'approved' : 'executed' } });
      expect(await invocation).toMatchObject({ kind: 'response', response: { execution: { ok: true } } });
      expect(effects).toBe(1);
      expect(ApprovalRequestV2Schema.parse(stored)).toMatchObject({ status: 'executed', actionArgs: input });
      if (actionId === 'daemon.filesystem.delete') expect(await readdir(rootPath)).toEqual([]);
      else if (actionId === 'daemon.filesystem.createDirectory') expect((await readdir(rootPath)).sort()).toEqual(['folder', 'original']);
      else if (actionId === 'projects.open') expect(await readFile(join(rootPath, 'original'))).toEqual(bytes);
      else expect(await readFile(join(rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed'
        : actionId === 'daemon.filesystem.copy' ? 'copy' : 'binary'))).toEqual(bytes);
      expect(await decidingExecutor.execute('approval.request.decide', { artifactId: 'own-approval', decision: 'approve' }, {
        surface: 'ui', authority: 'present_user',
      })).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(effects).toBe(1);
    } finally {
      await registration.dispose();
      coordinator.dispose('Test finished');
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
