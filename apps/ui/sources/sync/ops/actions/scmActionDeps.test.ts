import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScmCapabilities, ScmPullRequestPrepareWorktreeRequestSchema } from '@happier-dev/protocol/scm';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { subscribeAcknowledgedWorkspaceFileWrites } from '@/sync/domains/workspaces/files/workspaceFileAcknowledgements';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const { storage } = await import('@/sync/domains/state/storage');
const { createUiScmAction } = await import('./scmActionDeps');
const { sessionScmCommitUndoLast } = await import('@/sync/ops/sessionScm');

const executeCanonicalAction = async () => ({ ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action' });
const expectedHeadOid = 'a'.repeat(40);

beforeEach(async () => {
    await harness.reset();
    storage.setState(storage.getInitialState(), true);
    rpc.mockReset();
    rpc.mockImplementation(async ({ method }: { method: string }) => method === 'scm.backend.describe'
        ? { success: true, capabilities: createScmCapabilities({ writeCommitUndoLast: true }) }
        : method === 'scm.pullRequest.prepareWorktree' ? { success: true, targetPath: '/repo/review' }
        : { success: true, undoneCommitSha: expectedHeadOid });
});
afterEach(() => standardCleanup());

describe('SCM Action target binding', () => {
    it('acknowledges Discard and Restore hashes but not refused or kept-edited files', async ({ onTestFinished }) => {
        const hashes: Array<string | null> = [];
        const dispose = subscribeAcknowledgedWorkspaceFileWrites({ serverId: 'home', accountId: 'account',
            machineId: 'machine', rootPath: '/repo' }, 'file.txt', write => { hashes.push(write.hash); });
        onTestFinished(dispose);
        const invoke = createUiScmAction();
        const input = { cwd: '/repo', entries: [{ path: 'file.txt', kind: 'modified' as const }] };
        const context = { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine' as const, machineId: 'machine' } };
        for (const [status, hashAfter] of [['reverted', 'a'.repeat(64)], ['recreated', 'b'.repeat(64)],
            ['deleted', null], ['kept_edited', 'c'.repeat(64)], ['refused', null]] as const) {
            rpc.mockResolvedValueOnce({ success: true, entries: [{ path: 'file.txt', status,
                hashBefore: 'd'.repeat(64), hashAfter }] });
            await invoke({ actionId: 'scm.change.discard', input, context, executeCanonicalAction });
        }
        expect(hashes).toEqual(['a'.repeat(64), 'b'.repeat(64), null]);
    });
    it('acknowledges a Session discard on its resolved workspace, never the authored cwd', async () => {
        const serverId = await harness.addHome({ name: 'Selected Home', serverUrl: 'https://selected.example',
            accountId: 'account-other', serverIdentityId: 'srv_selected', currentAccount: true });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } });
        storage.setState({ sessions: { selected: createSessionFixture({ id: 'selected', serverId,
            metadata: { path: '/repo/selected', machineId: 'machine-other', host: 'host', homeDir: '/home/user' },
        }) } });
        const hashes: Array<string | null> = [];
        const workspace = { serverId, accountId: 'account-other', machineId: 'machine-other', rootPath: '/repo/selected' };
        const dispose = subscribeAcknowledgedWorkspaceFileWrites(workspace, 'file.txt', write => { hashes.push(write.hash); });
        const wrong: Array<string | null> = [];
        const disposeWrong = subscribeAcknowledgedWorkspaceFileWrites({ ...workspace, rootPath: '/repo/not-selected' }, 'file.txt',
            write => { wrong.push(write.hash); });
        try {
            rpc.mockResolvedValue({ success: true, entries: [{ path: 'file.txt', status: 'restored',
                hashBefore: 'a'.repeat(64), hashAfter: 'b'.repeat(64) }] });
            const result = await createUiScmAction()({ actionId: 'scm.change.discard',
                input: { cwd: '/repo/not-selected', entries: [{ path: 'file.txt', kind: 'modified' }] },
                context: { serverId, runtimeAccountId: 'account-other', defaultSessionId: 'selected' }, executeCanonicalAction });
            expect(result).toMatchObject({ success: true, entries: [{ path: 'file.txt', hashAfter: 'b'.repeat(64) }] });
            expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-other',
                method: 'scm.change.discard', payload: expect.objectContaining({ cwd: '/repo/selected' }) }));
            expect(hashes).toEqual(['b'.repeat(64)]);
            expect(wrong).toEqual([]);
        } finally { dispose(); disposeWrong(); }
    });
    it('acknowledges committed siblings in a partially refused Discard result', async ({ onTestFinished }) => {
        const hashes: Array<string | null> = [];
        onTestFinished(subscribeAcknowledgedWorkspaceFileWrites({ serverId: 'home', accountId: 'account',
            machineId: 'machine', rootPath: '/repo' }, 'file.txt', write => { hashes.push(write.hash); }));
        rpc.mockResolvedValue({ success: false, errorCode: 'CHANGE_MOVED_ON', error: 'Other file changed', entries: [
            { path: 'file.txt', status: 'reverted', hashBefore: 'a'.repeat(64), hashAfter: 'b'.repeat(64) },
            { path: 'other.txt', status: 'refused', hashBefore: null, hashAfter: null, errorCode: 'CHANGE_MOVED_ON' },
        ] });
        const result = await createUiScmAction()({ actionId: 'scm.change.discard',
            input: { cwd: '/repo', entries: [{ path: 'file.txt', kind: 'modified' }, { path: 'other.txt', kind: 'modified' }] },
            context: { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } },
            executeCanonicalAction });
        expect(result).toMatchObject({ success: false });
        expect(hashes).toEqual(['b'.repeat(64)]);
    });
    it('resolves an address on a Machine without a checkout or repository payload', async () => {
        const result = { success: true, kind: 'unknown' };
        rpc.mockResolvedValue(result);
        expect(await createUiScmAction()({ actionId: 'scm.hostingRepository.resolveAddress', input: { address: 'forge.test/team/repo' },
            context: { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } }, executeCanonicalAction,
        })).toEqual(result);
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine', serverId: 'home',
            method: 'scm.hostingRepository.resolveAddress', payload: { address: 'forge.test/team/repo' } }));
    });
    it('reads repository visibility on the selected Machine without a checkout and refuses an implicit Session', async () => {
        const input = { selector: { provider: { id: 'plugin/forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test' },
            repository: { nameWithOwner: 'team/repo' }, protocol: 'https' } };
        const result = { success: true, kind: 'private' };
        rpc.mockResolvedValue(result);
        const invoke = createUiScmAction();
        expect(await invoke({ actionId: 'scm.hostingRepository.get', input,
            context: { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } },
            executeCanonicalAction })).toEqual(result);
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine', serverId: 'home',
            method: 'scm.hostingRepository.get', payload: input }));
        expect(await invoke({ actionId: 'scm.hostingRepository.get', input,
            context: { defaultSessionId: 'session' }, executeCanonicalAction })).toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
    });
    it('routes machine inventory without inventing a repository and rejects a Session inventory request', async () => {
        const inventory = { success: true, results: [], count: 0, bytes: 0,
            sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } };
        rpc.mockResolvedValue(inventory);
        expect(await createUiScmAction()({ actionId: 'scm.diffSummary.result.list', input: {},
            context: { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } }, executeCanonicalAction,
        })).toEqual(inventory);
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine', payload: {}, method: 'scm.diffSummary.result.list' }));
        expect(await createUiScmAction()({ actionId: 'scm.diffSummary.result.list', input: {},
            context: { defaultSessionId: 'session' }, executeCanonicalAction,
        })).toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
    });
    it('does not attach a Git reconciliation outcome to an unconfirmed result edit', async () => {
        rpc.mockRejectedValue(new Error('Disconnected'));
        const response = await createUiScmAction()({ actionId: 'scm.diffSummary.result.edit',
            input: { cwd: '/repo', resultId: 'saved', expectedRevision: 1, edit: { kind: 'renameWalkthrough', title: 'Draft' } },
            context: { externalActionTarget: { kind: 'machine', machineId: 'machine' } }, executeCanonicalAction,
        });
        expect(response).toMatchObject({ success: false, errorCode: 'COMMAND_OUTCOME_UNKNOWN' });
        expect(response).not.toHaveProperty('outcome');
    });
    it('sends strict saved-result requests without Git mutation envelope fields', async () => {
        storage.setState({ settings: { ...storage.getState().settings, scmGitRepoPreferredBackend: 'sapling' } });
        rpc.mockResolvedValue({ success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 2 });
        const input = { cwd: '/repo', resultId: 'saved', expectedRevision: 1, edit: { kind: 'renameWalkthrough', title: 'Draft' } };
        expect(await createUiScmAction()({ actionId: 'scm.diffSummary.result.edit', input,
            context: { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } }, executeCanonicalAction,
        })).toEqual({ success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 2 });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ payload: input }));
    });
    it('refuses machine undo without an explicit repository instead of using daemon cwd', async () => {
        expect(await createUiScmAction()({ actionId: 'scm.commit.undoLast', input: { expectedHeadOid },
            context: { serverId: 'home-other', runtimeAccountId: 'account-other', externalActionTarget: { kind: 'machine', machineId: 'machine-other' } }, executeCanonicalAction,
        })).toMatchObject({ ok: false, errorCode: 'invalid_input' });
        expect(rpc).not.toHaveBeenCalled();
    });

    it('binds session undo and prepared-worktree source to the selected session repository', async () => {
        const serverId = await harness.addHome({ name: 'Selected Home', serverUrl: 'https://selected.example',
            accountId: 'account-other', serverIdentityId: 'srv_selected', currentAccount: true });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } });
        storage.setState({ sessions: { selected: createSessionFixture({ id: 'selected', serverId,
            metadata: { path: '/repo/selected', machineId: 'machine-other', host: 'host', homeDir: '/home/user' },
        }) } });
        const context = { serverId, runtimeAccountId: 'account-other', defaultSessionId: 'selected' };
        await createUiScmAction()({ actionId: 'scm.commit.undoLast', input: { cwd: '/repo/not-selected', expectedHeadOid }, context, executeCanonicalAction });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ serverId, accountId: 'account-other', machineId: 'machine-other',
            method: 'scm.commit.undoLast', payload: { cwd: '/repo/selected', expectedHeadOid, outcomeVersion: 1 },
        }));
        const preparedInput = ScmPullRequestPrepareWorktreeRequestSchema.parse({ cwd: '/repo/not-selected', sourcePath: '/repo/not-selected', prReference: { number: 7 } });
        await createUiScmAction()({ actionId: 'scm.pullRequest.prepareWorktree', input: preparedInput, context, executeCanonicalAction });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'scm.pullRequest.prepareWorktree', payload: {
            ...preparedInput, cwd: '/repo/selected', sourcePath: '/repo/selected', outcomeVersion: 1,
        } }));
        // Action binding must not change the ordinary facade's relative-path contract.
        const receipt = await sessionScmCommitUndoLast('selected', { cwd: 'nested', expectedHeadOid }, serverId);
        expect(receipt, JSON.stringify({ receipt, http: harness.requests.map(({ serverUrl, path }) => ({ serverUrl, path })) }))
            .toMatchObject({ success: true, undoneCommitSha: expectedHeadOid });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine-other',
            method: 'scm.commit.undoLast', payload: { cwd: '/repo/selected/nested', expectedHeadOid, outcomeVersion: 1 },
        }));
    });
});
