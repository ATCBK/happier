import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { requiresExactDaemonApprovalReplay } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1, PROJECT_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createActionApprovalContinuation } from '../../../../../apps/ui/sources/components/approvals/actionApprovalContinuation';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { assertActionOutputContract } from '@/testkit/actionOutputContract';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';

import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

// Each Home HTTP fixture is independent even though it uses the same origin.
beforeEach(() => resetServerFeaturesClientForTests());
afterEach(() => { vi.restoreAllMocks(); resetFilesystemApprovalSocketBoundary(); withdrawActiveProjectAccountRowsSnapshot(); });
const filesystemIds = ['daemon.filesystem.readFile', 'daemon.filesystem.writeFile', 'daemon.filesystem.listDirectory',
  'daemon.filesystem.getDirectoryTree', 'daemon.filesystem.createDirectory', 'daemon.filesystem.rename', 'daemon.filesystem.delete'] as const;
const bytes = Buffer.from([0, 255, 128, 10]);
const repository = { provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
  repository: { nameWithOwner: 'happier-dev/happier', cloneUrl: 'https://github.com/happier-dev/happier.git' }, protocol: 'https' as const };

describe('Machine filesystem approval continuity from UI and paired terminal', () => {
  it.each([
    ['projects.script.run', false], ['projects.script.run', true],
    ['projects.compute.exec', false], ['projects.compute.exec', true],
  ] as const)('executes signed portable worker %s through the installed factory (replay=%s)', async (actionId, replay) => {
    const h = await createHarness(actionId, replay ? 'ask' : 'allowed', false, 'srv_portableHome', undefined, true);
    try {
      const workspace = { serverId: h.ref.serverId, workspaceId: h.ref.id, machineId: h.ref.machineId, rootPath: h.rootPath };
      const input = { workspace, choice: { kind: 'workers', destination: { kind: 'machine', machineId: h.workerRef.machineId } },
        ...(actionId === 'projects.script.run' ? { selection: { kind: 'named', name: 'lint' } }
          : { executable: { kind: 'systemTool', id: 'make' }, argv: ['check'], cwd: h.rootPath }) };
      const result = await h.run(input, 'ui', false, 'present_user');
      if (replay) {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        expect(await h.decide('approve')).toMatchObject({ ok: true });
      }
      const accepted = replay ? (await h.approval()).execution : result;
      expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true });
      const output = ProjectCommandActionOutputV1Schema.parse(accepted?.result);
      expect(output.operation.domainRef).toMatchObject({ machineId: h.workerRef.machineId, workspaceRefId: h.workerRef.id,
        sourceWorkspace: workspace });
      await expect.poll(() => h.spawned.length).toBe(1);
      expect(h.copies()).toBe(1);
      expect(h.networkPaths).toContain('POST /v1/actions/projects.inspect');
      h.spawned[0]!.exit(0);
      expect(await h.waitForTerminal(output.operation.operationId)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
    } finally { await h.close(); }
  });

  it.each(['foreign Source Account', 'retired requester'] as const)('refuses portable worker execution for %s through installed requester custody', async reason => {
    const h = await createHarness('projects.script.run', 'allowed', false, 'srv_portableHome', undefined, true);
    try {
      if (reason === 'foreign Source Account') h.foreignSource(); else h.retireAfterCopy();
      const result = await h.run({ workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id, machineId: h.ref.machineId, rootPath: h.rootPath },
        selection: { kind: 'named', name: 'lint' }, choice: { kind: 'workers', destination: { kind: 'machine', machineId: h.workerRef.machineId } } },
        'ui', false, 'present_user');
      if (reason === 'foreign Source Account') {
        expect(result).toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable' });
        expect(h.copies()).toBe(0);
      } else {
        expect(result).toMatchObject({ ok: true });
        const operation = ProjectCommandActionOutputV1Schema.parse(result.ok ? result.result : null).operation;
        await expect.poll(() => h.readOperation(operation.operationId)).toMatchObject({ kind: 'found', operation: { state: 'failed' } });
        expect(h.copies()).toBe(1);
      }
      expect(h.spawned).toEqual([]);
    } finally { await h.close(); }
  });
  it.each([false, true])('runs reviewed This time setup and resumes the held script without remembered trust through the installed executor (unsigned UI: %s)', async unsignedUi => {
    const h = await createHarness('projects.script.run', 'allowed', true, unsignedUi ? 'srv_portableHome' : 'srv_n2');
    let operationId: string | undefined;
    try {
      const workspace = { serverId: h.ref.serverId, workspaceId: h.ref.id, machineId: h.ref.machineId, rootPath: h.rootPath };
      const inspected = await h.run({ workspace }, 'ui', false, 'present_user', 'projects.inspect', 'setup-inspection');
      expect(inspected, JSON.stringify(inspected)).toMatchObject({ ok: true });
      const before = ProjectDefinitionInspectOutputSchema.parse(inspected.ok ? inspected.result : null);
      expect(before).toMatchObject({ setupReadiness: { kind: 'unprepared' }, setupReview: {
        reviewedEffect: { commands: [{ kind: 'command', command: 'echo setup-reviewed' }] },
      } });
      expect(h.spawned).toEqual([]);
      const run = await h.run({ workspace, selection: { kind: 'named', name: 'lint' } }, 'ui', false, 'present_user');
      if (!run.ok) throw new Error(run.errorCode);
      const accepted = PROJECT_ACTION_OUTPUT_SCHEMAS_V1['projects.script.run'].parse(run.result);
      if (!('operation' in accepted)) throw new Error('Missing accepted script');
      operationId = accepted.operation.operationId;
      await expect.poll(() => h.readOperation(operationId!)).toMatchObject({ kind: 'found', operation: { setupReview: { code: 'project_setup_consent_required' } } });
      const held = ActionOperationGetV1ResponseSchema.parse(await h.readOperation(operationId));
      if (held.kind !== 'found' || !held.operation.setupReview) throw new Error('Missing actual held review');
      const changed = await h.run({ workspace, phase: 'setup', expectedEffectDigest: 'stale-review', consentScope: 'thisTime' },
        'ui', unsignedUi ? 'unsigned-ui' : false, 'present_user', 'projects.prepare', 'changed-setup-review');
      expect(changed).toMatchObject({ ok: false, errorCode: 'project_setup_effect_changed' });
      expect(h.hasApproval()).toBe(false);
      const setup = await h.run({ workspace, phase: 'setup', expectedEffectDigest: held.operation.setupReview.reviewedEffectDigest,
        consentScope: 'thisTime' }, 'ui', unsignedUi ? 'unsigned-ui' : false, 'present_user', 'projects.prepare', 'this-time-setup');
      expect(setup, JSON.stringify(setup)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'projects.prepare' } });
      expect(ActionApprovalRequestCreatedResultSchema.parse(setup.ok ? setup.result : null).actionId).toBe('projects.prepare');
      expect((await h.approval()).preview).toMatchObject({ setupReview: before.setupReview });
      const decision = await h.decide('approve');
      expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
      const prepared = (await h.approval()).execution;
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, result: { operation: { actionId: 'projects.prepare' } } });
      if (!prepared?.ok) throw new Error('Missing approved setup execution');
      const setupOperation = ProjectCommandActionOutputV1Schema.parse(prepared.result).operation;
      (await h.waitForSpawn(0)).exit(0);
      expect(await h.waitForTerminal(setupOperation.operationId)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
      // Native completion must wake the held owner without a client's extra
      // Get/Wait accidentally providing the missing lifecycle notification.
      await expect.poll(() => h.spawned.length, { timeout: 5_000 }).toBe(2);
      h.spawned[1]!.exit(1);
      expect(await h.waitForTerminal(operationId)).toMatchObject({ kind: 'found', operation: { state: 'failed', domainRef: { exitCode: 1 } } });
      expect(h.spawned).toHaveLength(2);
      expect(h.networkPaths).not.toContain('POST /v1/account/project-trust/mutate');
    } finally { if (operationId) await h.cancelOperation(operationId); await h.close(); }
  });
  it('returns admitted setup-held snapshots while the real review producer is awaiting Home instead of expiring read admission', async () => {
    const h = await createHarness('projects.script.run', 'allowed', true);
    let operationId: string | undefined;
    let release = () => {};
    try {
      const run = await h.run({ workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id, machineId: h.ref.machineId, rootPath: h.rootPath },
        selection: { kind: 'named', name: 'lint' } }, 'ui', false, 'present_user');
      if (!run.ok) throw new Error(run.errorCode);
      const accepted = PROJECT_ACTION_OUTPUT_SCHEMAS_V1['projects.script.run'].parse(run.result);
      if (!('operation' in accepted)) throw new Error('Missing accepted script');
      operationId = accepted.operation.operationId;
      await expect.poll(() => h.readOperation(operationId!)).toMatchObject({ kind: 'found', operation: { setupReview: { code: 'project_setup_consent_required' } } });
      const before = ActionOperationGetV1ResponseSchema.parse(await h.readReviewedOperation(operationId));
      const unchanged = ActionOperationGetV1ResponseSchema.parse(await h.readReviewedOperation(operationId));
      if (before.kind !== 'found' || unchanged.kind !== 'found') throw new Error('Missing retained review');
      expect.soft(unchanged.operation.revision).toBe(before.operation.revision);
      release = h.holdTrustRead();
      const pending = h.readTransportOperation(operationId, 100);
      // Model the transport owner's real deadline while the Home boundary is delayed.
      await new Promise<void>(resolve => setTimeout(resolve, 150));
      release();
      const response = await pending;
      expect(response).toMatchObject({ kind: 'found', operation: { operationId } });
      expect(ActionOperationGetV1ResponseSchema.safeParse(response).success).toBe(true);
      await h.readReviewedOperation(operationId);
      release = h.holdTrustRead();
      let reviewed = false;
      const fresh = h.readReviewedOperation(operationId).then(value => { reviewed = true; return value; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(reviewed).toBe(false);
      release();
      expect(ActionOperationGetV1ResponseSchema.safeParse(await fresh).success).toBe(true);
      expect(h.spawned).toEqual([]);
      expect(await h.cancelOperation(operationId)).toEqual({ kind: 'requested' });
      await expect.poll(() => h.readOperation(operationId!)).toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
    } finally { release(); if (operationId) await h.cancelOperation(operationId); await h.close(); }
  });
  it('settles Stop on an approved setup-held Project Run through installed operation wiring', async () => {
    const h = await createHarness('projects.script.run', 'ask', true, 'srv_portableHome');
    let operationId: string | undefined;
    try {
      const input = { workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id,
        machineId: h.ref.machineId, rootPath: h.rootPath }, selection: { kind: 'named', name: 'lint' } };
      expect(await h.run(input, 'ui')).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const decision = await h.decide('approve');
      expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
      const execution = (await h.approval()).execution;
      expect(execution).toMatchObject({ ok: true, result: { operation: { state: 'accepted' } } });
      const parsed = PROJECT_ACTION_OUTPUT_SCHEMAS_V1['projects.script.run'].parse(execution?.result);
      if (!('operation' in parsed)) throw new Error('Missing accepted finite operation');
      operationId = parsed.operation.operationId;
      await expect.poll(() => h.readOperation(operationId!)).toMatchObject({ kind: 'found', operation: {
        setupReview: { code: 'project_setup_consent_required' }, progress: { phase: 'setup' } } });
      // A verified peer grant is a different ingress from this installed
      // approval's private requester custody; it must not authorize Stop.
      expect(await h.unadmittedPeerCancel(operationId)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      expect(await h.readOperation(operationId)).toMatchObject({ kind: 'found', operation: { setupReview: {
        code: 'project_setup_consent_required' } } });
      const stop = await h.run({ serverId: h.ref.serverId, machineId: h.ref.machineId, operationId }, 'ui', 'unsigned-ui',
        'present_user', 'action.operations.cancel', 'stop-request');
      expect(stop).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(ActionApprovalRequestCreatedResultSchema.parse(stop.ok ? stop.result : null).actionId).toBe('action.operations.cancel');
      const stopped = await h.decide('approve');
      expect(stopped).toMatchObject({ ok: true });
      const stoppedExecution = (await h.approval()).execution;
      expect(stoppedExecution, JSON.stringify(stoppedExecution)).toMatchObject({ ok: true, result: { kind: 'requested' } });
      await expect.poll(() => h.readOperation(operationId!)).toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
    } finally {
      if (operationId) await h.cancelOperation(operationId);
      await h.close();
    }
  });
  it.each([false, true])('admits the first approved Machine Service Start with current requester custody (setup=%s)', async setup => {
    const h = await createHarness('localServices.launcher.start', 'ask', setup);
    try {
      const input = await h.serviceInput();
      const proposal = await h.run(input, 'ui', 'unsigned-ui', 'present_user');
      expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(requiresExactDaemonApprovalReplay(await h.approval())).toBe(true);
      expect(await h.decide('approve')).toMatchObject({ ok: true });
      const execution = (await h.approval()).execution;
      expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true,
        result: { status: 'denied', reasonCode: setup ? 'project_setup_consent_required' : 'project_service_effect_review_required' } });
      if (!execution?.ok) throw new Error('Missing real Service execution');
      assertActionOutputContract('localServices.launcher.start', execution.result);
      const response = DaemonLocalServiceLauncherStartResponseV1Schema.parse(execution.result);
      expect(response).toMatchObject({ machineId: h.ref.machineId, targetId: input.targetId,
        reviewedEffectDigest: expect.any(String), reviewedEffect: { purpose: setup ? 'setup' : 'service' } });
      const succeeded = vi.fn();
      const failed = vi.fn();
      const continuation = createActionApprovalContinuation({ artifactId: 'approval-seam', actionId: 'localServices.launcher.start',
        scope: { serverId: 'srv_n2', accountId: 'account' }, expectedInput: input, onSucceeded: succeeded, onFailed: failed });
      const receipt = await h.approval();
      expect(await continuation.onExecuted({ id: 'approval-seam', title: null, header: buildApprovalRequestArtifactHeaderV1(receipt),
        body: JSON.stringify(receipt), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2, isDecrypted: true })).toBe('consumed');
      expect(failed.mock.calls).toEqual([]);
      expect(succeeded).toHaveBeenCalledWith(response);
      expect(h.finiteIngress).toMatchObject([{ accountId: 'account', homeId: 'srv_n2', current: true }]);
    } finally { await h.close(); }
  });
  it.each(['cli', 'ui'] as const)('admits approved Machine Project Run replay from %s with the original requester custody through the installed executor', async surface => {
    const h = await createHarness('projects.script.run');
    try {
      const input = { workspace: { serverId: h.ref.serverId, workspaceId: h.ref.id,
        machineId: h.ref.machineId, rootPath: h.rootPath },
        selection: surface === 'cli' ? { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } }
          : { kind: 'named', name: 'lint' },
        ...(surface === 'ui' ? { choice: { kind: 'primary' } } : {}) };
      expect(await h.run(input, surface, surface === 'cli', 'account_automation'))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(h.finiteIngress).toEqual([]);
      const approval = await h.approval();
      expect(PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse(approval.actionArgs)).toEqual(input);
      expect(requiresExactDaemonApprovalReplay(approval)).toBe(true);
      expect(await h.decide('approve')).toMatchObject({ ok: true });
      const settled = await h.approval();
      expect(settled.execution, JSON.stringify(settled.execution)).toMatchObject({ ok: true, result: { operation: { state: 'accepted' } } });
      if (surface === 'ui') {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({ artifactId: 'approval-seam', actionId: 'projects.script.run',
          scope: { serverId: h.ref.serverId, accountId: 'account' }, expectedInput: input, onSucceeded, onFailed });
        await continuation.onExecuted({ id: 'approval-seam', title: null, header: buildApprovalRequestArtifactHeaderV1(settled),
          body: JSON.stringify(settled), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2, isDecrypted: true });
        expect(onFailed).not.toHaveBeenCalled();
        expect(onSucceeded).toHaveBeenCalledWith(settled.execution?.result);
      }
      expect(h.finiteIngress).toMatchObject([{ accountId: 'account', homeId: 'srv_n2', current: true }]);
      expect(h.finiteIngress[0].installationId).toBe(approval.executionOriginV1.externalActionExecutionAuthorization!.binding.installationId);
      // Unadmitted local invocation remains refused at the actual receiver.
      expect(await h.localFinite(input)).toMatchObject({ ok: false, errorCode: 'machine_admission_required' });
    } finally { await h.close(); }
  });
  it.each(filesystemIds.flatMap(actionId => (['ui', 'cli'] as const).flatMap(surface =>
    (['approve', 'reject'] as const).map(decision => ({ actionId, surface, decision })))))
  ('retains exact $actionId from $surface through $decision using production composition', async ({ actionId, surface, decision }) => {
    const h = await createHarness(actionId);
    const input = actionId === 'daemon.filesystem.rename' ? { rootPath: h.rootPath, from: 'original', to: 'renamed', overwrite: false }
      : actionId === 'daemon.filesystem.delete' ? { rootPath: h.rootPath, path: 'original', recursive: false }
      : actionId === 'daemon.filesystem.writeFile' ? { rootPath: h.rootPath, path: 'binary', content: bytes.toString('base64'), expectedHash: null }
      : actionId === 'daemon.filesystem.readFile' ? { rootPath: h.rootPath, path: 'original' }
      : actionId === 'daemon.filesystem.createDirectory' ? { rootPath: h.rootPath, path: 'folder' }
      : { rootPath: h.rootPath, path: '.', ...(actionId === 'daemon.filesystem.getDirectoryTree' ? { maxDepth: 1 } : {}) };
    try {
      expect(await h.run(input, surface)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId } });
      const checkoutName = basename(h.rootPath);
      const expectedSummary = actionId === 'daemon.filesystem.writeFile' ? `Write binary in ${checkoutName}`
        : actionId === 'daemon.filesystem.createDirectory' ? `Create the folder folder in ${checkoutName}`
        : actionId === 'daemon.filesystem.rename' ? `Rename original to renamed in ${checkoutName}`
        : actionId === 'daemon.filesystem.delete' ? `Delete original from ${checkoutName}`
        : null;
      expect(await h.approval()).toMatchObject({ status: 'open', actionArgs: input,
        ...(expectedSummary ? { summary: `${expectedSummary}.`, preview: { summary: `${expectedSummary}.` } } : {}),
        executionOriginV1: { requestId: 'original-request', surface, authority: 'account_automation', accountId: 'account',
          externalActionInputSignature: expect.any(String) } });
      expect(await readdir(h.rootPath)).toEqual(['original']);
      expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
      const decided = await h.decide(decision);
      expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: decision === 'reject' ? 'rejected' : 'executed' } });
      if (decision === 'reject') {
        expect(await h.replay()).toMatchObject({ ok: false, errorCode: 'approval_not_approved' });
        expect(await readdir(h.rootPath)).toEqual(['original']);
        expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
      } else {
        const result = (await h.approval()).execution?.result;
        if (actionId === 'daemon.filesystem.readFile') expect(result).toEqual({ success: true, content: bytes.toString('base64') });
        else if (actionId === 'daemon.filesystem.listDirectory') expect(result).toMatchObject({ success: true,
          entries: [expect.objectContaining({ name: 'original', type: 'file' })] });
        else if (actionId === 'daemon.filesystem.getDirectoryTree') expect(result).toMatchObject({ success: true,
          tree: { children: [expect.objectContaining({ name: 'original' })] } });
        else if (actionId === 'daemon.filesystem.delete') expect(await readdir(h.rootPath)).toEqual([]);
        else if (actionId === 'daemon.filesystem.createDirectory') expect((await stat(join(h.rootPath, 'folder'))).isDirectory()).toBe(true);
        else expect(await readFile(join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed' : 'binary'))).toEqual(bytes);
        if (actionId === 'daemon.filesystem.writeFile') expect(result).toMatchObject({ hash: createHash('sha256').update(bytes).digest('hex') });
        // An intervening edit distinguishes repeated effects from durable observation.
        const keptPath = join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed'
          : actionId === 'daemon.filesystem.delete' || actionId === 'daemon.filesystem.readFile' ? 'original' : 'binary');
        await writeFile(keptPath, 'subsequent user edit');
        if (actionId === 'daemon.filesystem.createDirectory') await rm(join(h.rootPath, 'folder'), { recursive: true });
        expect(await h.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(await readFile(keptPath, 'utf8')).toBe('subsequent user edit');
        expect((await h.approval()).execution?.result).toEqual(result);
        if (actionId === 'daemon.filesystem.createDirectory') await expect(stat(join(h.rootPath, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await readFile(join(h.directory, 'outside'), 'utf8')).toBe('outside unchanged');
    } finally { await h.close(); }
  });

  it.each((['daemon.filesystem.writeFile', 'daemon.filesystem.createDirectory', 'daemon.filesystem.rename', 'daemon.filesystem.delete'] as const)
    .flatMap(actionId => (['approve', 'reject', 'cancel'] as const).map(decision => ({ actionId, decision }))))
  ('retains the raw no-signal UI $actionId request id through $decision', async ({ actionId, decision }) => {
    const h = await createHarness(actionId);
    const input = actionId === 'daemon.filesystem.writeFile' ? { rootPath: h.rootPath, path: 'binary', content: bytes.toString('base64'), expectedHash: null }
      : actionId === 'daemon.filesystem.createDirectory' ? { rootPath: h.rootPath, path: 'folder' }
      : actionId === 'daemon.filesystem.rename' ? { rootPath: h.rootPath, from: 'original', to: 'renamed', overwrite: false }
      : { rootPath: h.rootPath, path: 'original', recursive: false };
    try {
      expect(await h.raw(input)).toMatchObject({ kind: 'approval_request_created' });
      expect(await h.approval()).toMatchObject({ status: 'open', executionOriginV1: { surface: 'rpc', requestId: 'original-request' } });
      expect(await h.decide('approve', 'account_automation')).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(await h.approval()).toMatchObject({ status: 'open' });
      expect(await readdir(h.rootPath)).toEqual(['original']);
      const decided = await h.decide(decision);
      expect(decided, JSON.stringify({ decided, networkPaths: h.networkPaths })).toMatchObject({ ok: true, result: { status: decision === 'approve' ? 'executed'
        : decision === 'reject' ? 'rejected' : 'canceled' } });
      if (decision !== 'approve') {
        expect(await h.replay()).toMatchObject({ ok: false, errorCode: 'approval_not_approved' });
        expect(await readdir(h.rootPath)).toEqual(['original']);
        expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
      } else {
        if (actionId === 'daemon.filesystem.delete') expect(await readdir(h.rootPath)).toEqual([]);
        else if (actionId === 'daemon.filesystem.createDirectory') expect((await stat(join(h.rootPath, 'folder'))).isDirectory()).toBe(true);
        else expect(await readFile(join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed' : 'binary'))).toEqual(bytes);
        await writeFile(join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed' : 'binary'), 'subsequent user edit');
        expect(await h.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(await readFile(join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed' : 'binary'), 'utf8')).toBe('subsequent user edit');
      }
    } finally { await h.close(); }
  });

  it.each(['ui', 'cli'] as const)('opens an issuer-approved folder from %s through authenticated Machine ingress', async surface => {
    const h = await createHarness('projects.open', 'ask');
    const input = { serverId: 'srv_n2', machineId: 'machine', source: { kind: 'folder', path: h.rootPath }, materialization: { kind: 'attach' } };
    try {
      const initialRows = JSON.stringify(h.rows);
      expect(await h.run(input, surface, surface === 'ui' ? 'unsigned-ui' : true, 'present_user'))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(JSON.stringify(h.rows)).toBe(initialRows);
      const result = await h.decide('approve');
      expect(result, JSON.stringify({ result, rpcOutcomes: h.rpcOutcomes })).toMatchObject({ ok: true, result: {
        status: 'executed', execution: { ok: true, result: { kind: 'opened', directory: h.rootPath,
          workspace: { serverId: 'srv_n2', machineId: 'machine', rootPath: h.rootPath } } },
      } });
      expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
    } finally { await h.close(); }
  });

  it.each((['ui', 'cli'] as const).flatMap(surface => (['ask', 'allowed'] as const).map(approval => ({ surface, approval }))))
  ('opens a real folder from $surface under $approval policy and retains its accepted row', async ({ surface, approval }) => {
    const h = await createHarness('projects.open', approval);
    const input = { serverId: 'srv_n2', machineId: 'machine', source: { kind: 'folder', path: h.rootPath }, materialization: { kind: 'attach' } };
    try {
      const initialRows = JSON.stringify(h.rows);
      const invocation = await h.run(input, surface);
      if (approval === 'ask') expect(JSON.stringify(h.rows)).toBe(initialRows);
      const result = approval === 'ask' ? await h.decide('approve') : invocation;
      if (approval === 'ask') expect(invocation).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const opened = { kind: 'opened', directory: h.rootPath, workspace: { serverId: 'srv_n2', machineId: 'machine', rootPath: h.rootPath } };
      expect(result, JSON.stringify({ result, rpcOutcomes: h.rpcOutcomes })).toMatchObject(approval === 'ask'
        ? { ok: true, result: { status: 'executed', execution: { ok: true, result: opened } } } : { ok: true, result: opened });
      const accepted = JSON.stringify(h.rows);
      if (approval === 'ask') expect(await h.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(JSON.stringify(h.rows)).toBe(accepted);
      expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
      if (approval === 'allowed') {
        h.disconnectInstalledMachine();
        expect(await h.run(input, surface, false, 'account_automation', 'projects.open', 'disconnected-open'))
          .toMatchObject({ ok: true, result: { kind: 'outcomeUnknown' } });
        expect(JSON.stringify(h.rows)).toBe(accepted);
      }
    } finally { await h.close(); }
  });

  it.each((['ui', 'cli'] as const).flatMap(surface => (['projects.list', 'projects.workspace.update', 'projects.workspace.forget',
    'projects.visibility.set', 'projects.context.update', 'projects.sources.list', 'projects.sources.read', 'projects.sources.create', 'projects.sources.update',
    'projects.sources.delete'] as const).flatMap(actionId => (['ask', 'allowed'] as const).map(approval => ({ actionId, surface, approval })))))
  ('admits $actionId Account custody from $surface under $approval policy and returns the real row or metadata outcome', async ({ actionId, surface, approval }) => {
    const h = await createHarness(actionId, approval);
    const input = actionId === 'projects.workspace.update' ? { serverId: 'srv_n2', workspaceId: h.ref.id, label: 'Renamed workspace' }
      : actionId === 'projects.workspace.forget' ? { serverId: 'srv_n2', workspaceId: h.ref.id }
      : actionId === 'projects.visibility.set' ? { target: { serverId: 'srv_n2', projectKey: 'project' }, expectedRevision: 2, hidden: true }
      : actionId === 'projects.context.update' ? { target: { serverId: 'srv_n2', projectKey: 'project' }, expectedRevision: 2,
        intent: { kind: 'detach', entryId: 'context-entry' } }
      : actionId === 'projects.sources.read' ? { serverId: 'srv_n2', sourceId: 'source' }
      : actionId === 'projects.sources.create' ? { serverId: 'srv_n2', requestKey: 'new-source', name: 'New source', repository }
      : actionId === 'projects.sources.update' ? { serverId: 'srv_n2', sourceId: 'source', expectedRevision: 2, patch: { name: 'Renamed source' } }
      : actionId === 'projects.sources.delete' ? { serverId: 'srv_n2', sourceId: 'source', expectedRevision: 2 }
      : { serverId: 'srv_n2' };
    try {
      const initialRows = JSON.stringify(h.rows); const initialSource = JSON.stringify(h.source());
      const pending = await h.run(input, surface);
      if (approval === 'ask') {
        expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        // These are original signed Account/terminal proposals, not the
        // Agent-Session or unsigned host-CLI proposals replayed by the app.
        expect(requiresExactDaemonApprovalReplay(await h.approval())).toBe(true);
        expect(JSON.stringify(h.rows)).toBe(initialRows);
        expect(JSON.stringify(h.source())).toBe(initialSource);
      }
      const result = approval === 'ask' ? await h.decide('approve') : pending;
      expect(result, JSON.stringify(result)).toMatchObject(approval === 'ask'
        ? { ok: true, result: { status: 'executed', execution: { ok: true } } } : { ok: true });
      const outcome = approval === 'ask' ? (await h.approval()).execution?.result : result.ok ? result.result : null;
      if (actionId === 'projects.list') expect(outcome).toMatchObject({ items: [expect.objectContaining({ rootPath: h.rootPath })] });
      else if (actionId === 'projects.workspace.update') expect(outcome).toMatchObject({ workspaceRef: { id: h.ref.id, label: 'Renamed workspace' } });
      else if (actionId === 'projects.workspace.forget') expect(h.rows.find(row => row.key.kind === 'workspace-ref')?.content).toBeNull();
      else if (actionId === 'projects.visibility.set') expect(outcome).toMatchObject({ row: { hidden: true }, revision: 3 });
      else if (actionId === 'projects.context.update') expect(outcome).toMatchObject({ row: { promptStack: [], hidden: false, pinned: false }, revision: 3 });
      else if (actionId === 'projects.sources.list') expect(outcome).toMatchObject({ sources: [{ id: 'source' }] });
      else if (actionId === 'projects.sources.read') expect(outcome).toMatchObject({ source: { id: 'source', name: 'App' } });
      else if (actionId === 'projects.sources.delete') expect(h.source()).toBeNull();
      else expect(h.source()).toMatchObject({ name: actionId === 'projects.sources.create' ? 'New source' : 'Renamed source' });
      const settledRows = JSON.stringify(h.rows); const settledSource = JSON.stringify(h.source());
      if (approval === 'ask') expect(await h.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(JSON.stringify(h.rows)).toBe(settledRows); expect(JSON.stringify(h.source())).toBe(settledSource);
      expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
    } finally { await h.close(); }
  });
});
