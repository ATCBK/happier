import * as filesystem from 'node:fs/promises';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import type { ScmPullRequestState, ScmPullRequestStatusProjection } from '@happier-dev/protocol/scm';
import { readStorageWorktreePullRequestState, readStorageWorktrees } from './readStorageWorktrees';

// Park only a genuine metadata boundary; SCM detection and discovery stay real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, lstat: vi.fn(actual.lstat) };
});

it('inspects independent indexed folders while another marker lookup is pending', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'storage-worktree-read-')));
    const first = join(root, 'first'); const sibling = join(root, 'sibling');
    await Promise.all([mkdir(first), mkdir(sibling)]);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const parked = new Promise<void>(resolve => { release = resolve; });
    let siblingEntered = false;
    const boundary = vi.mocked(filesystem.lstat).mockImplementation(async (...args) => {
        if (String(args[0]) === join(sibling, '.git')) siblingEntered = true;
        try { return await actual.lstat(...args); }
        catch (error) {
            if (String(args[0]) === join(first, '.git')) { enter(); await parked; }
            throw error;
        }
    });
    const discovery = readStorageWorktrees({ cwds: [], candidatePaths: [first, sibling] });
    try {
        await entered;
        expect(siblingEntered).toBe(true);
        release();
        expect(await discovery).toEqual([]);
    } finally { release(); await discovery; boundary.mockImplementation(actual.lstat); await rm(root, { recursive: true, force: true }); }
});

it('preserves an unreadable marker as a failed inspection instead of a non-repository', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'storage-worktree-denied-')));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const denied = Object.assign(new Error('Marker permission unavailable'), { code: 'EACCES' });
    const boundary = vi.mocked(filesystem.lstat).mockImplementation(async (...args) => {
        if (String(args[0]) === join(root, '.git')) throw denied;
        return actual.lstat(...args);
    });
    try { await expect(readStorageWorktrees({ cwds: [], candidatePaths: [root] })).rejects.toBe(denied); }
    finally { boundary.mockImplementation(actual.lstat); await rm(root, { recursive: true, force: true }); }
});

it('retains draft reviews and preserves unknown hosting evidence instead of confirming no open review', () => {
    const status = (state: ScmPullRequestState | null, authState: ScmPullRequestStatusProjection['authState'] = 'authenticated'): ScmPullRequestStatusProjection => ({
        provider: null, baseBranch: 'main', headBranch: 'feature', authState,
        openPullRequest: state === null ? null : { provider: { id: 'fixture', kind: 'custom', displayName: 'Fixture',
            baseUrl: 'https://example.invalid', urlSafety: { allowedSchemes: ['https:'] } },
            title: 'Review', url: 'https://example.invalid/review/1', baseBranch: 'main', headBranch: 'feature', state },
    });
    expect(readStorageWorktreePullRequestState(status('draft'))).toBe('open');
    expect(readStorageWorktreePullRequestState(status('open'))).toBe('open');
    expect(readStorageWorktreePullRequestState(status('unknown'))).toBeUndefined();
    expect(readStorageWorktreePullRequestState(status(null, 'unknown'))).toBeUndefined();
    expect(readStorageWorktreePullRequestState(undefined)).toBeUndefined();
    expect(readStorageWorktreePullRequestState(status(null))).toBeNull();
    expect(readStorageWorktreePullRequestState(status(null, 'unsupported'))).toBeNull();
    expect(readStorageWorktreePullRequestState(status('closed'))).toBe('closed');
    expect(readStorageWorktreePullRequestState(status('merged'))).toBe('merged');
});
