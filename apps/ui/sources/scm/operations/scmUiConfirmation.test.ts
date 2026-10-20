import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeScmCapabilities } from '@/scm/core/snapshotMappers';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } from '@happier-dev/protocol/scm/worktrees';
import type { ScmRemotePolicy } from '@happier-dev/protocol/scm';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

// Every SCM write a person starts from the app ends with exactly one confirmation, or none
// when the surface or the person's setting says so. The real default Action executor and
// approval policy run; only the confirmation dialog and the Machine RPC are faked.
const confirm = vi.hoisted(() => vi.fn(async (_title: string, _message?: string) => true));
const alert = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
/** What the person and the pane saw, in order: the dialog, the busy state and the Machine RPC. */
const order: string[] = [];
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
  confirmResult: true,
  spies: { confirm, alert },
}).module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

const snapshotFor = (kind: 'pull' | 'push') => ({
  projectKey: 'machine-1:/repo', fetchedAt: 1, stashCount: 0, hasConflicts: false,
  repo: { isRepo: true, rootPath: '/repo', backendId: 'git' },
  branch: { head: 'main', upstream: 'origin/main', upstreamOid: 'a'.repeat(40), ahead: 1, behind: kind === 'pull' ? 2 : 0, detached: false },
  capabilities: mergeScmCapabilities({ changeSetModel: 'index', writeRemotePush: true, writeRemotePull: true, writeRemoteFetch: true, writeRemotePolicies: true, writeRemoteForceWithLease: true }),
  totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
  entries: [],
} satisfies ScmWorkingSnapshot);

let homeServerId = '';

/** The person's Source Control preference is the Account setting the Action executor reads; callers pass no policy. */
async function runRemote(kind: 'pull' | 'push', options: Readonly<{ confirmed?: boolean; policy?: ScmRemotePolicy }> = {}) {
  const { executeScmRemoteOperation } = await import('./executeScmRemoteOperation');
  const machineScm = await import('@/sync/ops/scm/machineScm');
  const reportOperation = vi.fn();
  const setScmOperationBusy = vi.fn((busy: boolean) => { order.push(`busy:${busy}`); });
  await executeScmRemoteOperation({
    kind, repoPath: '/repo', scmSnapshot: snapshotFor(kind), scmWriteEnabled: true, scmCommitStrategy: 'atomic',
    scmPushRejectPolicy: 'prompt_fetch', surface: 'update', policy: options.policy,
    ...(options.confirmed ? { skipConfirmation: true } : {}),
    setScmOperationBusy, setScmOperationStatus: vi.fn(),
    runWithOperationLock: async (_kind, run) => { await run(() => {}); return { started: true }; },
    executeRemoteOperation: (operation, target, call) => operation === 'pull'
      ? machineScm.machineScmRemotePull('machine-1', { cwd: '/repo', remote: target.remote, branch: target.branch ?? undefined }, call) as never
      : machineScm.machineScmRemotePush('machine-1', { cwd: '/repo', remote: target.remote, branch: target.branch ?? undefined, ...options.policy }, call) as never,
    reportOperation, refreshAfterSuccess: async () => {},
  });
  return { reportOperation, setScmOperationBusy };
}

function setRemoteConfirmPolicy(policy: 'always' | 'never' | 'pull_only' | 'push_only') {
  storage.getState().applySettingsLocal({ scmRemoteConfirmPolicy: policy });
}

describe('SCM write confirmation from the app', () => {
  beforeEach(async () => {
    order.length = 0;
    confirm.mockImplementation(async () => { order.push('confirm'); return true; });
    machineRpcWithServerScopeMock.mockImplementation(async () => { order.push('rpc'); return { success: true }; });
    await harness.reset();
    const serverId = homeServerId = await harness.addHome({
      name: 'SCM Home', serverUrl: 'https://scm.example', accountId: 'account-b',
      serverIdentityId: 'srv_scm', currentAccount: true,
    });
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-b' };
    storage.setState({ settingsScope: scope, profileScope: scope });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.getState().applySettingsLocal({ actionsSettingsV1: normalizeActionsSettingsV1(undefined), scmRemoteConfirmPolicy: 'always' });
  });
  afterEach(() => {
    confirm.mockClear();
    alert.mockClear();
    machineRpcWithServerScopeMock.mockReset();
    standardCleanup();
  });

  // `scmRemoteConfirmPolicy` is the person's preference. It is one input to the Action executor's
  // single confirmation (the UI default of the remote Actions), never a second dialog in a caller.
  it.each(['pull', 'push'] as const)('%s with scmRemoteConfirmPolicy never and the default Action policy opens no dialog', async (kind) => {
    setRemoteConfirmPolicy('never');
    await runRemote(kind);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(['pull', 'push'] as const)('%s with scmRemoteConfirmPolicy always is confirmed once by the executor and names its target', async (kind) => {
    setRemoteConfirmPolicy('always');
    await runRemote(kind);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    const [title = '', message = ''] = confirm.mock.calls[0] ?? [];
    expect(message).toContain('origin/main');
    expect(message.replace(/\.$/, '')).not.toBe(title);
  });

  it.each([
    ['pull_only', 'pull', 1], ['pull_only', 'push', 0], ['push_only', 'push', 1], ['push_only', 'pull', 0],
  ] as const)('policy %s asks %s %i time(s)', async (policy, kind, asked) => {
    setRemoteConfirmPolicy(policy);
    await runRemote(kind);
    expect(confirm).toHaveBeenCalledTimes(asked);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
  });

  // An explicit Ask first is the Action policy's own approval request. It is the only prompt: the
  // preference adds no dialog in front of it, and nothing is dispatched until someone approves.
  it.each(['never', 'always'] as const)('with scmRemoteConfirmPolicy %s and Ask first on the push Action the executor asks once and no dialog stacks', async (policy) => {
    setRemoteConfirmPolicy(policy);
    await harness.requireUiApproval(homeServerId, 'scm.remote.push');
    const { reportOperation } = await runRemote('push');
    expect(confirm).not.toHaveBeenCalled();
    // A requested approval is a pending state, not a failure: no alert, no failed log entry.
    expect(alert).not.toHaveBeenCalled();
    expect(reportOperation).not.toHaveBeenCalled();
    expect(harness.artifacts(homeServerId).list()).toHaveLength(1);
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('Ask first on any SCM write is a quiet pending result with a neutral Review notice, never an unsupported-feature failure', async () => {
    const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
    const { isScmActionNotRun } = await import('@/sync/ops/scm/scmActionInvocation');
    const machineScm = await import('@/sync/ops/scm/machineScm');
    await harness.requireUiApproval(homeServerId, 'scm.change.include');
    retirePresentationNotice();
    const response = await machineScm.machineScmChangeInclude('machine-1', { cwd: '/repo', paths: ['a.ts'] });
    expect(isScmActionNotRun(response)).toBe(true);
    expect(response).toMatchObject({ awaitingApproval: true, approvalArtifactId: expect.any(String) });
    expect(response).not.toMatchObject({ errorCode: 'FEATURE_UNSUPPORTED' });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    expect(readPresentationNotice()).toMatchObject({ severity: 'info', message: 'Waiting for your approval', undo: { label: 'Review' } });
    retirePresentationNotice();
  });

  it('an explicit Allowed on the push Action wins over the Source Control preference', async () => {
    setRemoteConfirmPolicy('always');
    storage.getState().applySettingsLocal({ actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: { 'scm.remote.push': ['ui'] } }) });
    await runRemote('push');
    expect(confirm).not.toHaveBeenCalled();
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
  });

  it('a press the person already answered in a choice dialog is not asked again by the preference', async () => {
    setRemoteConfirmPolicy('always');
    await runRemote('pull', { confirmed: true, policy: { reconcile: 'merge' } });
    expect(confirm).not.toHaveBeenCalled();
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
  });

  it('a declined remote confirmation sends nothing and stays quiet', async () => {
    setRemoteConfirmPolicy('always');
    confirm.mockResolvedValueOnce(false);
    const { reportOperation } = await runRemote('push');
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    expect(reportOperation).not.toHaveBeenCalled();
  });

  // The pane is busy (and the lock label shows "Pushing to origin/main…") only once the person has said yes.
  it.each(['pull', 'push'] as const)('%s shows the busy state after the confirmation and before the Machine RPC, never before', async (kind) => {
    setRemoteConfirmPolicy('always');
    await runRemote(kind);
    expect(order.filter(event => event !== 'busy:false')).toEqual(['confirm', 'busy:true', 'rpc']);
  });

  it('a push needing no confirmation is busy immediately before the Machine RPC', async () => {
    setRemoteConfirmPolicy('never');
    await runRemote('push');
    expect(order.filter(event => event !== 'busy:false')).toEqual(['busy:true', 'rpc']);
  });

  it('a declined or approval-pending press never marks the pane busy', async () => {
    setRemoteConfirmPolicy('always');
    confirm.mockResolvedValueOnce(false);
    await runRemote('push');
    await harness.requireUiApproval(homeServerId, 'scm.remote.push');
    await runRemote('push');
    expect(order).not.toContain('busy:true');
    expect(order).not.toContain('rpc');
  });

  it.each(['never', 'always'] as const)('a force push with lease is confirmed once by the executor whatever the preference (%s)', async (policy) => {
    setRemoteConfirmPolicy(policy);
    await runRemote('push', { policy: { pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40) } });
    expect(confirm).toHaveBeenCalledTimes(1);
    const [, message = ''] = confirm.mock.calls[0] ?? [];
    expect(message).toContain('origin/main');
    expect(message).toContain('aaaaaaa');
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
  });

  it('a force push with lease plus Ask first is still one prompt', async () => {
    setRemoteConfirmPolicy('always');
    await harness.requireUiApproval(homeServerId, 'scm.remote.push');
    await runRemote('push', { policy: { pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40) } });
    expect(confirm).not.toHaveBeenCalled();
    expect(harness.artifacts(homeServerId).list()).toHaveLength(1);
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  // The mutation runner (merge, rebase, abort, remote edits, commit undo) holds its operation `queued` while the
  // Action asks the person, and flips it to `running` only when the Action reaches the Machine.
  describe('the mutation runner', () => {
    const scope = { serverId: 'srv_scm', machineId: 'machine-1', rootPath: '/repo' };
    beforeEach(async () => { (await import('@/sync/runtime/orchestration/projectManager')).projectManager.clear(); });
    const phase = async () => (await import('@/sync/runtime/orchestration/projectManager')).projectManager.getWorkspaceScmInFlightOperation(scope)?.phase;
    async function merge() {
      const { runWorkspaceScmMutation } = await import('./runSessionScmMutation');
      const { machineScmBranchMerge } = await import('@/sync/ops/scm/machineScm');
      const setScmOperationBusy = vi.fn();
      const result = await runWorkspaceScmMutation({
        state: storage.getState(), scope, cwd: '/repo', operation: 'branch_merge', fallbackError: 'Merge failed', setScmOperationBusy,
        run: (call) => machineScmBranchMerge('machine-1', { cwd: '/repo', sourceRef: 'topic' }, call),
      });
      return { result, setScmOperationBusy };
    }

    it('keeps a confirmed merge queued behind its dialog and running only once it is dispatched', async () => {
      const seen: string[] = [];
      confirm.mockImplementation(async () => { seen.push(`confirm:${await phase()}`); return true; });
      machineRpcWithServerScopeMock.mockImplementation(async () => { seen.push(`rpc:${await phase()}`); return { success: true }; });
      const { setScmOperationBusy } = await merge();
      expect(seen).toEqual(['confirm:queued', 'rpc:running']);
      expect(setScmOperationBusy).toHaveBeenNthCalledWith(1, true);
      expect(await phase()).toBeUndefined();
    });

    it('never runs, shows busy or logs a failure for a declined merge or one waiting for approval', async () => {
      const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
      const { isScmActionNotRun } = await import('@/sync/ops/scm/scmActionInvocation');
      const phases: Array<string | undefined> = [];
      confirm.mockImplementation(async () => { phases.push(await phase()); return false; });
      const declined = await merge();
      await harness.requireUiApproval(homeServerId, 'scm.branch.merge');
      const pending = await merge();
      for (const { result, setScmOperationBusy } of [declined, pending]) {
        expect(result.started && isScmActionNotRun(result.response)).toBe(true);
        expect(setScmOperationBusy).not.toHaveBeenCalledWith(true);
      }
      expect(phases).toEqual(['queued']);
      expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
      expect(projectManager.getWorkspaceScmOperationLog(scope)).toEqual([]);
      expect(alert).not.toHaveBeenCalled();
    });
  });

  // Callers that run an SCM Action outside the runner present a waiting approval as the neutral notice, not an alert.
  it('a workspace commit waiting for approval is not logged, alerted or reported as failed', async () => {
    const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
    const { executeWorkspaceScmCommit } = await import('@/components/projects/scm/executeWorkspaceScmCommit');
    const scope = { serverId: 'srv_scm', machineId: 'machine-1', rootPath: '/repo' };
    projectManager.clear();
    await harness.requireUiApproval(homeServerId, 'scm.commit.create');
    const refreshScmData = vi.fn(async () => {});
    const result = await executeWorkspaceScmCommit({
      scope, commitMessage: 'fix: a', scmCommitStrategy: 'atomic', commitSelectionPaths: ['a.ts'], commitSelectionPatches: [],
      refreshScmData, setScmOperationBusy: vi.fn(), setScmOperationStatus: vi.fn(), tracking: null,
    });
    expect(result).toEqual({ ok: false });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(refreshScmData).not.toHaveBeenCalled();
    expect(projectManager.getWorkspaceScmOperationLog(scope)).toEqual([]);
  });

  it.each([
    ['stage', 'machineScmChangeInclude', { cwd: '/repo', paths: ['a.ts'] }],
    ['unstage', 'machineScmChangeExclude', { cwd: '/repo', paths: ['a.ts'] }],
    ['commit', 'machineScmCommitCreate', { cwd: '/repo', message: 'fix: a' }],
    ['fetch', 'machineScmRemoteFetch', { cwd: '/repo' }],
    ['branch create', 'machineScmBranchCreate', { cwd: '/repo', name: 'topic' }],
    ['branch checkout', 'machineScmBranchCheckout', { cwd: '/repo', name: 'topic', strategy: 'bring_changes' }],
    ['undo last commit', 'machineScmCommitUndoLast', { cwd: '/repo', expectedHeadOid: 'a'.repeat(40) }],
    // Restoring a stash is recoverable (a conflict keeps the stash), so no dialog.
    ['stash pop', 'machineScmStashPop', { cwd: '/repo', stashRef: 'stash@{0}' }],
  ] as const)('%s dispatches without a generic dialog', async (_name, facade, request) => {
    const machineScm = await import('@/sync/ops/scm/machineScm');
    await (machineScm[facade] as (machineId: string, request: unknown) => Promise<unknown>)('machine-1', request);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('discard is confirmed exactly once by the Action policy and dispatches after acceptance', async () => {
    const { machineScmChangeDiscard } = await import('@/sync/ops/scm/machineScm');
    await machineScmChangeDiscard('machine-1', { cwd: '/repo', entries: [{ path: 'a.ts', kind: 'modified' }] });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
  });

  it('a discard is dispatched (its pane starts showing work in progress) only after the confirmation, and never when declined', async () => {
    const { machineScmChangeDiscard } = await import('@/sync/ops/scm/machineScm');
    const request = { cwd: '/repo', entries: [{ path: 'a.ts', kind: 'modified' as const }] };
    await machineScmChangeDiscard('machine-1', request, { onDispatched: () => { order.push('dispatched'); } });
    expect(order).toEqual(['confirm', 'dispatched', 'rpc']);
    order.length = 0;
    confirm.mockResolvedValueOnce(false);
    await machineScmChangeDiscard('machine-1', request, { onDispatched: () => { order.push('dispatched'); } });
    expect(order).toEqual([]);
  });

  it.each([
    ['discard', 'machineScmChangeDiscard', { cwd: '/repo', entries: [{ path: 'a.ts', kind: 'modified' }] }],
    ['merge', 'machineScmBranchMerge', { cwd: '/repo', sourceRef: 'topic' }],
    ['worktree removal', 'machineScmWorktreeRemove', { cwd: '/repo', worktreePath: '/repo/wt', confirmed: true, authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN }],
  ] as const)('a declined %s confirmation sends nothing and is a quiet decline, not an unsupported feature', async (_name, facade, request) => {
    confirm.mockResolvedValueOnce(false);
    const machineScm = await import('@/sync/ops/scm/machineScm');
    const { isScmActionNotRun } = await import('@/sync/ops/scm/scmActionInvocation');
    const response = await (machineScm[facade] as (machineId: string, request: unknown) => Promise<{ errorCode?: string }>)('machine-1', request);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    expect(isScmActionNotRun(response)).toBe(true);
    expect(response.errorCode).not.toBe('FEATURE_UNSUPPORTED');
  });

  it.each([
    ['one file', [{ path: 'notes/today.md', kind: 'modified' }], ['notes/today.md']],
    ['several files', ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(path => ({ path, kind: 'modified' as const })), ['5 files', 'a.ts', 'b.ts', 'c.ts', '2 more']],
  ] as const)('the discard confirmation names %s and says it cannot be undone', async (_name, entries, named) => {
    const { machineScmChangeDiscard } = await import('@/sync/ops/scm/machineScm');
    await machineScmChangeDiscard('machine-1', { cwd: '/repo', entries: [...entries] });
    expect(confirm).toHaveBeenCalledTimes(1);
    const message = confirm.mock.calls[0]?.[1] ?? '';
    for (const part of named) expect(message).toContain(part);
    expect(message).toContain('can’t be undone');
  });

  it.each([
    ['merge', 'machineScmBranchMerge', { cwd: '/repo', sourceRef: 'topic' }, ['topic']],
    ['rebase', 'machineScmBranchRebase', { cwd: '/repo', sourceRef: 'topic' }, ['topic', 'rewrites']],
    ['skip a step', 'machineScmBranchOperationSkip', { cwd: '/repo', operation: 'rebase' }, ['rebase']],
    ['worktree removal', 'machineScmWorktreeRemove', { cwd: '/repo', worktreePath: '/repo/wt', confirmed: true, authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN }, ['/repo/wt', 'can’t be undone']],
    ['worktree pruning', 'machineScmWorktreePrune', { cwd: '/repo' }, ['no longer exist']],
    ['abort a merge or rebase', 'machineScmBranchOperationAbort', { cwd: '/repo', operation: 'merge' }, ['merge in progress', 'thrown away']],
    ['stash drop', 'machineScmStashDrop', { cwd: '/repo', stashRef: 'stash@{0}' }, ['stash@{0}', 'can’t be undone']],
  ] as const)('the %s confirmation is asked once and explains itself rather than repeating its title', async (_name, facade, request, named) => {
    const machineScm = await import('@/sync/ops/scm/machineScm');
    await (machineScm[facade] as (machineId: string, request: unknown) => Promise<unknown>)('machine-1', request);
    expect(confirm).toHaveBeenCalledTimes(1);
    const [title = '', message = ''] = confirm.mock.calls[0] ?? [];
    expect(message.replace(/\.$/, '')).not.toBe(title);
    for (const part of named) expect(message).toContain(part);
  });

  it.each([
    ['continue a merge or rebase', 'machineScmBranchOperationContinue', { cwd: '/repo', operation: 'merge' }],
    ['remove a remote', 'machineScmRemoteRemove', { cwd: '/repo', name: 'up' }],
    ['add a remote', 'machineScmRemoteAdd', { cwd: '/repo', name: 'up', fetchUrl: 'https://example.test/up.git' }],
    ['publish a branch', 'machineScmRemotePublish', { cwd: '/repo', remote: 'origin' }],
  ] as const)('%s dispatches without a generic dialog because the action is recoverable', async (_name, facade, request) => {
    const machineScm = await import('@/sync/ops/scm/machineScm');
    await (machineScm[facade] as (machineId: string, request: unknown) => Promise<unknown>)('machine-1', request);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });
});
