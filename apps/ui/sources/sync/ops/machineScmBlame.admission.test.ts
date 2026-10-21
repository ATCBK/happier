import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { decideApprovalAsInbox, installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const rpc = vi.hoisted(() => ({ call: vi.fn() }));
// Only remote Machine IO is replaced; the facade, policy, Artifact and hook stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: unknown) => rpc.call(request),
}));
await import('@/sync/ops/actions/defaultActionExecutor');
const { useFileBlame } = await import('@/sync/domains/session/changes/hooks/useFileBlame');

const result = { success: true, commits: [], ranges: [{ startLine: 1, lineCount: 1, commitIndex: null }] };
let serverId: string;
const input = () => ({ scope: { serverId, accountId: 'acct', machineId: 'machine', rootPath: '/repo' },
    path: 'a.ts', content: { text: 'saved\n', hash: 'a'.repeat(64) }, enabled: true, readBlame: true,
    labels: { uncommitted: 'Uncommitted', turn: (turnId: string) => turnId } });

beforeEach(async () => {
    await homes.reset(); rpc.call.mockReset().mockResolvedValue(result);
    const profileId = await homes.addHome({ name: 'Blame Home', serverUrl: 'https://blame-admission.test',
        serverIdentityId: 'srv_blame_admission', accountId: 'acct', currentAccount: true, active: false });
    serverId = resolveServerProfileScopeIdForIdentifier(profileId);
});
afterEach(async () => { standardCleanup(); await homes.reset(); });

describe('Show blame Action admission', () => {
    it('reads saved-file blame by default without creating an approval', async () => {
        const hook = await renderHook(() => useFileBlame(input()));
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ loading: false,
            runs: [{ kind: 'uncommitted', startLine: 1, lineCount: 1 }] }));
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
        expect(rpc.call).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.SCM_BLAME_FILE,
            machineId: 'machine', accountId: 'acct', payload: expect.objectContaining({ path: 'a.ts', expectedHash: 'a'.repeat(64) }) }));
    });

    it('withdraws superseded Ask blame and delivers only the newest approved native receipt', async () => {
        await homes.requireUiApproval(serverId, 'scm.blame.get');
        await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId, accountId: 'acct', machineId: 'machine' });
        const hook = await renderHook(useFileBlame, { initialProps: input() });
        const artifacts = homes.artifacts(serverId);
        await waitForHomeGovernance(() => expect(artifacts.list().length > 0 || !hook.getCurrent().loading).toBe(true));
        expect(artifacts.list()).toHaveLength(1);
        const oldId = artifacts.list()[0]!.id;
        expect(hook.getCurrent()).toMatchObject({ loading: true, runs: [] });
        expect(rpc.call).not.toHaveBeenCalled();
        await hook.rerender({ ...input(), content: { text: 'new saved\n', hash: 'b'.repeat(64) } });
        await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(2));
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(oldId)!)).status).toBe('canceled');
        await decideApprovalAsInbox(serverId, oldId, 'approve');
        expect(rpc.call).not.toHaveBeenCalled();
        const newest = artifacts.list().find(artifact => artifact.id !== oldId)!.id;
        expect(await decideApprovalAsInbox(serverId, newest, 'approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
        await act(async () => { publishHomeAccountChange(serverId, [newest]); });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ loading: false,
            runs: [{ kind: 'uncommitted', lineCount: 1 }] }));
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(newest)!)))
            .toMatchObject({ status: 'executed', approval: { flow: 'deferred' }, execution: { ok: true, result } });
        expect(rpc.call.mock.calls.map(([request]) => request.payload.expectedHash)).toEqual(['b'.repeat(64)]);
    });

    it.each(['reject', 'hide'] as const)('settles a %s of pending Show blame without reading the file', async decision => {
        await homes.requireUiApproval(serverId, 'scm.blame.get');
        const hook = await renderHook(useFileBlame, { initialProps: input() });
        const artifacts = homes.artifacts(serverId);
        await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(1));
        const artifactId = artifacts.list()[0]!.id;
        if (decision === 'hide') await hook.rerender({ ...input(), enabled: false });
        else {
            await decideApprovalAsInbox(serverId, artifactId, 'reject');
            await act(async () => { publishHomeAccountChange(serverId, [artifactId]); });
        }
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        await waitForHomeGovernance(() => expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!)).status)
            .toBe(decision === 'hide' ? 'canceled' : 'rejected'));
        expect(hook.getCurrent().runs).toEqual([]);
        if (decision === 'reject') expect(hook.getCurrent().errorCode).toBe('COMMAND_CANCELLED');
        expect(rpc.call).not.toHaveBeenCalled();
    });

    it('starts only on an active File page and retains its pending read while Inbox navigation covers it', async () => {
        const hook = await renderHook((props: { active: boolean }) => useFileBlame({ ...input(), active: props.active }),
            { initialProps: { active: false } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(rpc.call).not.toHaveBeenCalled();
        await homes.requireUiApproval(serverId, 'scm.blame.get');
        await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId, accountId: 'acct', machineId: 'machine' });
        await hook.rerender({ active: true });
        const artifacts = homes.artifacts(serverId);
        await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(1));
        const artifactId = artifacts.list()[0]!.id;
        // pushRetainingCurrent keeps the File page mounted but selects Inbox.
        await hook.rerender({ active: false });
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!)).status).toBe('open');
        expect(await decideApprovalAsInbox(serverId, artifactId, 'approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
        await act(async () => { publishHomeAccountChange(serverId, [artifactId]); });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ loading: false,
            runs: [{ kind: 'uncommitted', lineCount: 1 }] }));
        await hook.rerender({ active: true });
        expect(artifacts.list()).toHaveLength(1);
        expect(rpc.call.mock.calls.map(([request]) => request.payload.expectedHash)).toEqual(['a'.repeat(64)]);
    });
});
