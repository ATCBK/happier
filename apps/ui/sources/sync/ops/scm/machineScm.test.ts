import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@/sync/domains/settings/settings';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

import { SCM_OPERATION_ERROR_CODES, SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
let serverId: string;
function setScmSettings(fixture: Readonly<{ settings: Partial<Settings> }>) {
    storage.setState({ settings: { ...storage.getState().settings, ...fixture.settings } });
}

type MachineScmTestCall = (machineId: string, request: Record<string, unknown>) => Promise<unknown>;

// The in-place confirmation is the only mocked boundary; the Action executor and policy stay real.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));


describe('machineScm', () => {
    beforeEach(async () => {
        await harness.reset();
        serverId = await harness.addHome({ name: 'SCM Home', serverUrl: 'https://scm.example', accountId: 'account-b',
            serverIdentityId: 'srv_scm', currentAccount: true });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-b' };
        storage.setState({ settingsScope: scope, profileScope: scope });
        // Ordinary no-explicit-Home facades consume the applied Account runtime,
        // not merely the device's persisted Home selection.
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    });
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        standardCleanup();
    });

    it('runs SCM status snapshot through server-scoped machine RPC with the requested cwd and backend preference', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'sapling',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { machineScmStatusSnapshot } = await import('./machineScm');
        const response = await machineScmStatusSnapshot('machine-1', {
            cwd: '/repo',
        });

        expect(response.success, JSON.stringify(response)).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
            payload: {
                cwd: '/repo',
                outcomeVersion: 1,
                operationStateVersion: 1,
                backendPreference: {
                    kind: 'prefer',
                    backendId: 'sapling',
                },
            },
            timeoutMs: undefined,
        }));
    });

    it('classifies a transport failure as an unavailable backend instead of a failed command', async () => {
        // `F-UI-2`: `scmFallbackError` is only reached from the CATCH of the machine RPC — a real
        // git failure comes back as a well-formed `{ success: false, error, errorCode }` response and
        // never throws. So the terminal branch was labelling "no answer arrived" as COMMAND_FAILED and
        // handing the raw exception text to the UI, which rendered an internal
        // `TypeError: Cannot read properties of undefined (reading 'emit')` in the user error slot.
        setScmSettings({ settings: {} });
        machineRpcWithServerScopeMock.mockRejectedValue(
            new TypeError("Cannot read properties of undefined (reading 'emit')"),
        );

        const { machineScmStatusSnapshot } = await import('./machineScm');
        const response = await machineScmStatusSnapshot('machine-1', { cwd: '/repo' });

        expect(response).toEqual({
            success: false,
            error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
            errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
        });
        expect(JSON.stringify(response)).not.toContain('emit');
    });

    it('forwards a projected packed backend preference through the canonical SCM request', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
                scmGitRepoPreferredBackendQualifiedId: 'acme.scm/stacked',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, snapshot: undefined });

        const { machineScmStatusSnapshot } = await import('./machineScm');
        await machineScmStatusSnapshot('machine-1', { cwd: '/repo' });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: {
                cwd: '/repo',
                outcomeVersion: 1,
                operationStateVersion: 1,
                backendPreference: {
                    kind: 'prefer',
                    backendId: 'acme.scm/stacked',
                },
            },
        }));
    });

    it('keeps qualified first-party preferences compatible with legacy CLI backend ids', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'sapling',
                scmGitRepoPreferredBackendQualifiedId: 'happier.scm.backend.git/git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, snapshot: undefined });

        const { machineScmStatusSnapshot } = await import('./machineScm');
        await machineScmStatusSnapshot('machine-1', { cwd: '/repo' });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: { cwd: '/repo', outcomeVersion: 1, operationStateVersion: 1 },
        }));
    });

    it('threads a caller AbortSignal through machineScmLogList into the machine RPC', async () => {
        setScmSettings({ settings: {} });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, entries: [] });
        const controller = new AbortController();

        const { machineScmLogList } = await import('./machineScm');
        const response = await machineScmLogList(
            'machine-1',
            { cwd: '/repo', limit: 20, query: 'fix login' },
            { serverId: serverId, accountId: 'account-b', signal: controller.signal },
        );

        expect(response.success, JSON.stringify(response)).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_LOG_LIST,
            serverId: serverId,
            accountId: 'account-b',
            signal: controller.signal,
            payload: expect.objectContaining({ cwd: '/repo', query: 'fix login' }),
        }));
    });

    it('parses scm.log.list through the canonical closed response schema', async () => {
        setScmSettings({ settings: {} });
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            entries: [],
            queryApplied: true,
            authoritativeScope: 'all-refs',
        });

        const { machineScmLogList } = await import('./machineScm');
        await expect(machineScmLogList(
            'machine-1',
            { cwd: '/repo', query: 'fix login' },
        )).rejects.toMatchObject({
            issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['authoritativeScope'] })],
        });
    });

    it('rethrows transport failure as cancellation instead of backend-unavailable when the caller aborted', async () => {
        // A cancelled commit search must reach the search adapter as an abort so the section can
        // discard it silently — not as BACKEND_UNAVAILABLE, which would render offline truth for
        // a query the user simply left.
        setScmSettings({ settings: {} });
        const controller = new AbortController();
        const transportError = new Error('socket closed');
        machineRpcWithServerScopeMock.mockImplementation(async () => {
            controller.abort();
            throw transportError;
        });

        const { machineScmLogList } = await import('./machineScm');
        await expect(machineScmLogList(
            'machine-1',
            { cwd: '/repo', query: 'fix login' },
            { serverId: serverId, signal: controller.signal },
        )).rejects.toBe(transportError);
    });

    it('maps unavailable machine-rpc failures to the standard backend unavailable SCM response', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );

        const { machineScmBranchList } = await import('./machineScm');
        const response = await machineScmBranchList('machine-1', {
            cwd: '/repo',
            includeRemotes: true,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE);
        expect(response.error).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE);
    });

    it('routes worktree create, remove, and prune through canonical machine SCM RPCs', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, stdout: '', stderr: '', worktreePath: '/repo/.dev/worktree/feature-auth', branchName: 'feature-auth' });

        const { machineScmWorktreeCreate, machineScmWorktreePrune, machineScmWorktreeRemove } = await import('./machineScm');
        const createResponse = await machineScmWorktreeCreate('machine-1', {
            cwd: '/repo',
            displayName: 'feature-auth',
            baseRef: 'main',
        });
        const removeResponse = await machineScmWorktreeRemove('machine-1', {
            cwd: '/repo',
            worktreePath: '/repo/.dev/worktree/feature-auth',
            confirmed: true,
            authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
        });
        const pruneResponse = await machineScmWorktreePrune('machine-1', {
            cwd: '/repo',
        });

        expect(createResponse.success, JSON.stringify(createResponse)).toBe(true);
        expect(removeResponse.success, JSON.stringify(removeResponse)).toBe(true);
        expect(pruneResponse.success, JSON.stringify(pruneResponse)).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_WORKTREE_CREATE,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                    displayName: 'feature-auth',
                    baseRef: 'main',
                },
                timeoutMs: undefined,
            }),
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_WORKTREE_REMOVE,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                    worktreePath: '/repo/.dev/worktree/feature-auth',
                    confirmed: true,
                    authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
                },
                timeoutMs: undefined,
            }),
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_WORKTREE_PRUNE,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                },
                timeoutMs: undefined,
            }),
        );
    });

    it('passes the requested server scope through worktree creation RPCs', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, stdout: '', stderr: '', worktreePath: '/repo/.dev/worktree/feature-auth', branchName: 'feature-auth' });

        const { machineScmWorktreeCreate } = await import('./machineScm');
        const response = await machineScmWorktreeCreate(
            'machine-1',
            {
                cwd: '/repo',
                displayName: 'feature-auth',
            },
            { serverId: serverId },
        );

        expect(response.success, JSON.stringify(response)).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_WORKTREE_CREATE,
            serverId: resolveServerProfileScopeIdForIdentifier(serverId),
            payload: expect.objectContaining({
                cwd: '/repo',
                displayName: 'feature-auth',
            }),
        }));
    });

    it('passes the requested server scope through non-worktree machine SCM RPCs', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, stdout: '', stderr: '', worktreePath: '/repo/.dev/worktree/feature-auth', branchName: 'feature-auth' });

        const { machineScmBranchCreate } = await import('./machineScm');
        const response = await machineScmBranchCreate(
            'machine-1',
            {
                cwd: '/repo',
                name: 'feature/auth',
                checkout: true,
            },
            { serverId: serverId },
        );

        expect(response.success, JSON.stringify(response)).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_BRANCH_CREATE,
            serverId: resolveServerProfileScopeIdForIdentifier(serverId),
            payload: expect.objectContaining({
                cwd: '/repo',
                name: 'feature/auth',
                checkout: true,
            }),
        }));
    });

    it('routes remote management and branch integration through canonical machine SCM RPCs', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, stdout: '', stderr: '', worktreePath: '/repo/.dev/worktree/feature-auth', branchName: 'feature-auth' });

        const module = await import('./machineScm');
        const machineScmRemoteAdd = (module as unknown as {
            machineScmRemoteAdd: MachineScmTestCall;
        }).machineScmRemoteAdd;
        const machineScmRemoteSetUrl = (module as unknown as {
            machineScmRemoteSetUrl: MachineScmTestCall;
        }).machineScmRemoteSetUrl;
        const machineScmBranchMerge = (module as unknown as {
            machineScmBranchMerge: MachineScmTestCall;
        }).machineScmBranchMerge;
        const machineScmBranchOperationAbort = (module as unknown as {
            machineScmBranchOperationAbort: MachineScmTestCall;
        }).machineScmBranchOperationAbort;

        await machineScmRemoteAdd('machine-1', {
            cwd: '/repo',
            name: 'origin',
            fetchUrl: '/tmp/remote.git',
        });
        await machineScmRemoteSetUrl('machine-1', {
            cwd: '/repo',
            name: 'origin',
            pushUrl: null,
        });
        await machineScmBranchMerge('machine-1', {
            cwd: '/repo',
            sourceRef: 'feature',
        });
        await machineScmBranchOperationAbort('machine-1', {
            cwd: '/repo',
            operation: 'merge',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_REMOTE_ADD,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                    name: 'origin',
                    fetchUrl: '/tmp/remote.git',
                },
                timeoutMs: undefined,
            }),
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_REMOTE_SET_URL,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                    name: 'origin',
                    pushUrl: null,
                },
                timeoutMs: undefined,
            }),
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_BRANCH_MERGE,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                    sourceRef: 'feature',
                },
                timeoutMs: undefined,
            }),
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            4,
            expect.objectContaining({
                machineId: 'machine-1',
               method: RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
               payload: {
                    outcomeVersion: 1,
                    cwd: '/repo',
                    operation: 'merge',
                },
                timeoutMs: undefined,
            }),
        );
    });

    it('passes the SCM diff-commit timeout through the canonical machine RPC wrapper', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            diff: '',
        });

        const { machineScmDiffCommit } = await import('./machineScm');
        await machineScmDiffCommit('machine-1', {
            cwd: '/repo',
            commit: 'abc123',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_DIFF_COMMIT,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                commit: 'abc123',
            },
            timeoutMs: 120_000,
        }));
    });

    it('routes remove index-lock through the canonical machine SCM RPC', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            removed: true,
            reason: 'removed',
            lockPath: '/repo/.git/index.lock',
        });

        const { machineScmRepositoryRemoveIndexLock } = await import('./machineScm');
        const response = await machineScmRepositoryRemoveIndexLock('machine-1', {
            cwd: '/repo',
            confirmed: true,
            confirmationToken: 'remove-stale-index-lock',
        });

        expect(response).toMatchObject({
            success: true,
            removed: true,
            reason: 'removed',
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                confirmed: true,
                confirmationToken: 'remove-stale-index-lock',
            },
            timeoutMs: undefined,
        }));
    });

    it('maps remove index-lock missing machine RPC to feature unsupported response', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            }),
        );

        const { machineScmRepositoryRemoveIndexLock } = await import('./machineScm');
        const response = await machineScmRepositoryRemoveIndexLock('machine-1', {
            cwd: '/repo',
            confirmed: true,
            confirmationToken: 'remove-stale-index-lock',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        expect(response.error).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND);
    });

    it('routes pull-request read and compose operations through canonical machine SCM RPCs', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ success: true, pullRequests: [] })
            .mockResolvedValueOnce({ success: true, pullRequest: null })
            .mockResolvedValueOnce({ success: true, nextAction: { kind: 'none' } });

        const module = await import('./machineScm');
        await module.machineScmPullRequestList('machine-1', {
            cwd: '/repo',
            base: 'main',
            head: 'feature/pr-cache',
            state: 'open',
        });
        await module.machineScmPullRequestGet('machine-1', {
            cwd: '/repo',
            prReference: { number: 42 },
        });
        await module.machineScmPullRequestOpenCompose('machine-1', {
            cwd: '/repo',
            base: 'main',
            head: 'feature/pr-cache',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_PULL_REQUEST_LIST,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                base: 'main',
                head: 'feature/pr-cache',
                state: 'open',
            },
            timeoutMs: undefined,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_PULL_REQUEST_GET,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                prReference: { number: 42 },
            },
            timeoutMs: undefined,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                base: 'main',
                head: 'feature/pr-cache',
            },
            timeoutMs: undefined,
        }));
    });

    it('routes pull-request open-or-reuse and repository provisioning through canonical machine SCM RPCs', async () => {
        setScmSettings({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ success: true, reused: true, nextAction: { kind: 'none' } })
            .mockResolvedValueOnce({ success: true, alreadyInitialized: false })
            .mockResolvedValueOnce({ success: true, auth: { state: 'authenticated', profileKind: 'provider_cli' }, defaultRepositoryName: 'repo', targets: [] })
            .mockResolvedValueOnce({ success: true, pushed: true,
                repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    nameWithOwner: 'acme/repo', webUrl: 'https://github.com/acme/repo', visibility: 'private' },
                remote: { name: 'origin', fetchUrl: 'https://github.com/acme/repo.git', pushUrl: 'https://github.com/acme/repo.git' },
            });

        const module = await import('./machineScm');
        expect(module.machineScmPullRequestOpenOrReuse).toBeTypeOf('function');
        expect(module.machineScmRepositoryInit).toBeTypeOf('function');
        expect(module.machineScmHostingRepositoryDescribePublishTargets).toBeTypeOf('function');
        expect(module.machineScmHostingRepositoryPublish).toBeTypeOf('function');

        await module.machineScmPullRequestOpenOrReuse('machine-1', {
            cwd: '/repo',
            base: 'trunk',
            head: 'feature/pr-cache',
        });
        await module.machineScmRepositoryInit('machine-1', {
            cwd: '/repo',
        });
        await module.machineScmHostingRepositoryDescribePublishTargets('machine-1', {
            cwd: '/repo',
            providerKind: 'github',
        });
        await module.machineScmHostingRepositoryPublish('machine-1', {
            cwd: '/repo',
            providerKind: 'github',
            owner: 'acme',
            repositoryName: 'repo',
            visibility: 'private',
            remoteName: 'origin',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                base: 'trunk',
                head: 'feature/pr-cache',
            },
            timeoutMs: undefined,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_REPOSITORY_INIT,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
            },
            timeoutMs: undefined,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                providerKind: 'github',
            },
            timeoutMs: undefined,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(4, expect.objectContaining({
            machineId: 'machine-1',
           method: RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
           payload: {
                outcomeVersion: 1,
                cwd: '/repo',
                providerKind: 'github',
                owner: 'acme',
                repositoryName: 'repo',
                visibility: 'private',
                remoteName: 'origin',
            },
            timeoutMs: undefined,
        }));
    });
});
