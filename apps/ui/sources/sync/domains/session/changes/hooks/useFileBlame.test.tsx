import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createDeferred, createSessionFixture, createToolCallMessageFixture, renderHook } from '@/dev/testkit';
import type { Message, TranscriptAccountActor } from '@happier-dev/session-core/messages';
import type { ScmBlameFileResponse } from '@happier-dev/protocol/scm';
import { useFileBlame, type UseFileBlameInput } from './useFileBlame';

const { blame } = vi.hoisted(() => ({ blame: vi.fn() }));
// The Machine RPC is the external boundary; attribution and evidence derivation remain real.
vi.mock('@/sync/ops/machineScmBlame', () => ({ machineScmBlameFile: blame }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
let session = createSessionFixture({ id: 's', serverId: 'home' });
let messages: Message[] = [];
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSession: () => session,
        useSessionMessages: () => ({ messages }),
    });
});
const actor: TranscriptAccountActor = {
    v: 1, serverId: 'home', accountId: 'alice',
    profile: { name: 'Alice', firstName: 'Alice', lastName: null, username: 'alice', avatarUrl: null },
};
const input: UseFileBlameInput = {
    scope: { machineId: 'machine', rootPath: '/repo', serverId: 'home', accountId: 'alice' },
    path: 'a.ts', content: { text: 'new\nhuman\n', hash: 'a'.repeat(64) }, enabled: true, readBlame: true,
    labels: { uncommitted: 'Uncommitted', turn: (turnId) => `Turn ${turnId}` },
    session: { address: { serverId: 'home', sessionId: 's' }, agentLabel: 'Agent', title: 'Fix',
        authorship: { viewerScope: actor, hasOtherNamedCollaborator: true } },
};
const uncommitted: ScmBlameFileResponse = { success: true, commits: [], ranges: [{ startLine: 1, lineCount: 2, commitIndex: null }] };

beforeEach(() => {
    blame.mockReset();
    blame.mockResolvedValue(uncommitted);
    session = createSessionFixture({ id: 's', serverId: 'home', hasOtherNamedCollaborator: true,
        sessionTurns: { v: 1, sessionId: 's', updatedAt: 1, turns: [{ turnId: 't', status: 'completed', startedAt: 1, updatedAt: 2,
            transcriptAnchors: { startUserMessageSeq: 1 } }] } });
    messages = [
        { kind: 'user-text', id: 'u', seq: 1, localId: null, createdAt: 1, text: 'Fix', accountActor: actor },
        createToolCallMessageFixture({ id: 'diff', seq: 3, tool: {
            name: 'Diff', state: 'completed', createdAt: 2, startedAt: 2, completedAt: 3, description: null,
            input: { files: [{ file_path: '/repo/a.ts', change_kind: 'modified', unified_diff: '@@ -1 +1 @@\n-old\n+new\n' }],
                _happier: { v: 2, protocol: 'agent', provider: 'agent', rawToolName: 'Diff', canonicalToolName: 'Diff',
                    sessionChangeScope: 'turn', turnId: 't', sessionId: 's', source: 'provider_native', confidence: 'exact',
                    turnStatus: 'completed', seqRange: { startSeqInclusive: 1, endSeqInclusive: 3 } } },
        } }),
    ];
});

describe('useFileBlame', () => {
    it('composes the Machine ranges, canonical turn evidence and exact initiating Account', async () => {
        // The transcript's canonical authorship projection owns this fact, including when the
        // full Session row has not caught up with its Home-qualified list projection.
        session = { ...session, hasOtherNamedCollaborator: false };
        const hook = await renderHook(useFileBlame, { initialProps: input });
        expect(hook.getCurrent().runs).toMatchObject([
            { kind: 'session', startLine: 1, lineCount: 1, turn: { turnId: 't', requester: { actor, name: 'message.accountActorYou' } } },
            { kind: 'uncommitted', startLine: 2, lineCount: 1 },
        ]);
        expect(blame).toHaveBeenCalledWith('machine', { cwd: '/repo', path: 'a.ts', expectedHash: input.content!.hash },
            expect.objectContaining({ serverId: 'home', accountId: 'alice', signal: expect.any(AbortSignal) }));
        await hook.rerender({ ...input, session: { ...input.session!, authorship: {
            ...input.session!.authorship, hasOtherNamedCollaborator: false,
        } } });
        expect(hook.getCurrent().runs[0]).toMatchObject({ turn: { requester: null } });
    });

    it('ignores a prior hash response and asks again for the displayed saved bytes', async () => {
        const pending = createDeferred<ScmBlameFileResponse>();
        blame.mockReturnValueOnce(pending.promise);
        const hook = await renderHook(useFileBlame, { initialProps: input });
        expect(hook.getCurrent().loading).toBe(true);
        await hook.rerender({ ...input, content: { text: 'human\nhuman\n', hash: 'b'.repeat(64) } });
        expect(hook.getCurrent().runs.every((run) => run.kind === 'uncommitted')).toBe(true);
        await pending.resolve({ success: true, ranges: [], commits: [] });
        await hook.rerender();
        expect(hook.getCurrent().runs).toHaveLength(1);
        expect(hook.getCurrent().loading).toBe(false);
    });

    it('does not request blame while hidden or unsupported', async () => {
        const hook = await renderHook(useFileBlame, { initialProps: { ...input, enabled: false } });
        expect(hook.getCurrent().runs).toEqual([]);
        expect(blame).not.toHaveBeenCalled();
        await hook.rerender({ ...input, readBlame: false });
        expect(blame).not.toHaveBeenCalled();
    });

    it('returns stale-file state without presenting ranges for different bytes', async () => {
        blame.mockResolvedValue({ success: false, errorCode: 'stale_file', error: 'Changed' });
        const hook = await renderHook(() => useFileBlame(input));
        expect(hook.getCurrent()).toMatchObject({ runs: [], stale: true, loading: false, errorCode: 'stale_file' });
    });

    it('refreshes commit attribution after HEAD changes even when saved bytes have the same hash', async () => {
        const hook = await renderHook(() => useFileBlame(input));
        expect(hook.getCurrent().runs[0]?.kind).toBe('session');
        blame.mockResolvedValueOnce({ success: true,
            ranges: [{ startLine: 1, lineCount: 2, commitIndex: 0 }],
            commits: [{ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', authorName: 'Alex', authoredAtMs: 1, summary: 'Committed' }],
        });
        await act(async () => hook.getCurrent().refresh());
        expect(hook.getCurrent().runs).toMatchObject([{ kind: 'commit', lineCount: 2, commit: { authorName: 'Alex' } }]);
        expect(blame.mock.calls.map((call) => call[1].expectedHash)).toEqual([input.content!.hash, input.content!.hash]);
    });

    it('retains the same saved-file blame while an explicit refresh is pending', async () => {
        const pending = createDeferred<ScmBlameFileResponse>();
        const hook = await renderHook(() => useFileBlame(input));
        const previous = hook.getCurrent().runs;
        blame.mockReturnValueOnce(pending.promise);
        await act(async () => hook.getCurrent().refresh());
        expect(hook.getCurrent().loading).toBe(true);
        expect(hook.getCurrent().runs).toBe(previous);
        await act(async () => pending.resolve(uncommitted));
        expect(hook.getCurrent().loading).toBe(false);
    });

    it('withholds the previous Account response while the exact new Account is loading', async () => {
        const pending = createDeferred<ScmBlameFileResponse>();
        const hook = await renderHook(useFileBlame, { initialProps: input });
        expect(hook.getCurrent().runs.length).toBeGreaterThan(0);
        blame.mockReturnValueOnce(pending.promise);
        await hook.rerender({ ...input, scope: { ...input.scope!, accountId: 'other-account' }, session: null });
        expect(hook.getCurrent()).toMatchObject({ runs: [], loading: true });
        expect(blame).toHaveBeenLastCalledWith('machine', expect.anything(), expect.objectContaining({ accountId: 'other-account' }));
        pending.resolve(uncommitted);
        await hook.rerender();
        expect(hook.getCurrent().loading).toBe(false);
    });

    it('keeps project scope git-only and never reads another Home Session as evidence', async () => {
        const hook = await renderHook<ReturnType<typeof useFileBlame>, UseFileBlameInput>(useFileBlame, {
            initialProps: { ...input, session: null },
        });
        expect(hook.getCurrent().runs).toMatchObject([{ kind: 'uncommitted', lineCount: 2 }]);
        await hook.rerender({ ...input, session: { ...input.session!, address: { serverId: 'other', sessionId: 's' } } });
        expect(hook.getCurrent().runs).toMatchObject([{ kind: 'uncommitted', lineCount: 2 }]);
    });
});
