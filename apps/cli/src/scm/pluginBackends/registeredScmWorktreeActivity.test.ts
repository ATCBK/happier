import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createRegisteredScmBackendAdapter } from './registeredScmBackendAdapter';
import { scmWorktreeMutationActivity } from '../worktreeMutationActivity';
import { createScmBackendRegistry } from '../registry';
import { createScmHostingProviderRegistry } from '../hostingProviders/registry';
import { createStorageCategoryCatalog } from '@/storage/categoryCatalog';
import { readStorageWorktrees } from '@/daemon/resources/readStorageWorktrees';
import { createStorageWorktreeOperations } from '@/storage/worktrees/storageWorktreeOperations';

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
}).trim();
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-scm-activity-')));
    roots.push(root);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'Worktree activity fixture');
    git(root, 'config', 'user.email', 'worktree@example.invalid');
    await writeFile(join(root, '.gitignore'), '.dev/\ntrash/\n');
    await writeFile(join(root, 'file'), 'original');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'initial');
    const first = join(root, '.dev', 'worktree', 'first');
    const second = join(root, '.dev', 'worktree', 'second');
    git(root, 'worktree', 'add', '-b', 'first', first);
    git(root, 'worktree', 'add', '-b', 'second', second);
    const payload = join(root, 'trash', 'entry', 'payload');
    await mkdir(join(root, 'trash', 'entry'), { recursive: true });
    const registration = createGitScmBackendRuntimeRegistration();
    const hostingRegistry = createScmHostingProviderRegistry({ providers: [], runtimeRegistrations: [] });
    const backend = createRegisteredScmBackendAdapter({
        definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
        executableDefinition: registration.runtime!, registration,
        hostingProviderRuntimeServices: { resolveScmHostingProviderRegistry: async () => hostingRegistry },
    });
    const context = { cwd: root, projectKey: root, detection: { isRepo: true, rootPath: root, mode: '.git' as const } };
    return { root, first, second, payload, backend, context };
}
beforeAll(() => console.info('SCM activity fixture runtime:', process.platform, process.version,
    execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()));
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('registered worktree mutation activity', () => {
    it('binds the maintenance idle requirement to both current and recovered SCM owner adapters', async () => {
        const f = await fixture();
        const registry = createScmBackendRegistry([f.backend]);
        const catalog = createStorageCategoryCatalog({
            happyHomeDir: join(f.root, 'home'), activeServerDir: join(f.root, 'server'), tempRoot: join(f.root, 'tmp'),
            readWorktrees: () => readStorageWorktrees({ cwds: [f.root], registry }),
            worktreeOperations: createStorageWorktreeOperations({ happyHomeDir: join(f.root, 'home'), registry }),
        });
        const item = (await catalog.discover()).find(value => value.path === f.first);
        if (!item) throw new Error('Expected registered worktree');
        const adapter = await catalog.resolveAdapter(item);
        expect(adapter.requiresIdle).toBe(true);
        expect((await catalog.adapterForEntry('worktrees', adapter.ownerData)).requiresIdle).toBe(true);
    });

    it('stays busy across active and queued native mutations, then notifies idle without interrupting either', async () => {
        const f = await fixture();
        const firstEntered = deferred(); const releaseFirst = deferred();
        const secondEntered = deferred(); const releaseSecond = deferred();
        const observed: boolean[] = [];
        const unsubscribe = scmWorktreeMutationActivity.subscribe(() => observed.push(scmWorktreeMutationActivity.isIdle()));
        const unsubscribeBrokenObserver = scmWorktreeMutationActivity.subscribe(() => { throw new Error('observer failed'); });
        const retiring = f.backend.worktreeRetire!({ context: { ...f.context,
            beforeFilesystemMutation: async () => { firstEntered.resolve(); await releaseFirst.promise; },
        }, request: { worktreePath: f.first, targetPath: f.payload, entryId: 'entry' } });
        let removing: ReturnType<typeof f.backend.worktreeRemove> | undefined;
        try {
            await firstEntered.promise;
            expect(scmWorktreeMutationActivity.isIdle()).toBe(false);
            removing = f.backend.worktreeRemove({ context: { ...f.context,
                beforeFilesystemMutation: async () => { secondEntered.resolve(); await releaseSecond.promise; },
            }, request: { worktreePath: f.second, confirmed: true, authorizationToken: 'remove-worktree' } });
            releaseFirst.resolve();
            expect(await retiring).toMatchObject({ success: true });
            await secondEntered.promise;
            expect(scmWorktreeMutationActivity.isIdle()).toBe(false);
            expect(observed).not.toContain(true);
            releaseSecond.resolve();
            expect(await removing).toMatchObject({ success: true });
            expect(scmWorktreeMutationActivity.isIdle()).toBe(true);
            expect(observed).toEqual([false, true]);
            expect(git(f.root, 'worktree', 'list', '--porcelain')).toContain('locked happier-trash:entry');
            expect(git(f.root, 'show-ref', '--verify', 'refs/heads/second')).toContain('refs/heads/second');
        } finally {
            releaseFirst.resolve(); releaseSecond.resolve();
            await Promise.allSettled([retiring, ...(removing ? [removing] : [])]);
            unsubscribe(); unsubscribeBrokenObserver();
        }
    });

    it('observes native create, prune and reinstate lifetimes and becomes idle after a rejected filesystem guard', async () => {
        const f = await fixture();
        const checkout = f.backend.workspaceIntegration!.createWorkspaceCheckout!({ context: f.context,
            workspaceCheckoutCreation: { kind: 'git_worktree', sourcePath: f.root, displayName: 'workspace-created', baseRef: 'main', branchMode: 'new' },
        });
        try {
            expect(scmWorktreeMutationActivity.isIdle()).toBe(false);
            expect(await checkout).toMatchObject({ created: true, branchName: 'workspace-created' });
        } finally { await checkout; }
        const created = f.backend.worktreeCreate({ context: f.context, request: { displayName: 'created', baseRef: 'main' } });
        try {
            expect(scmWorktreeMutationActivity.isIdle()).toBe(false);
            expect(await created).toMatchObject({ success: true });
        } finally { await created; }
        const pruned = f.backend.worktreePrune({ context: f.context, request: {} });
        try {
            expect(scmWorktreeMutationActivity.isIdle()).toBe(false);
            expect(await pruned).toMatchObject({ success: true });
        } finally { await pruned; }
        expect(await f.backend.worktreeRetire!({ context: f.context,
            request: { worktreePath: f.first, targetPath: f.payload, entryId: 'entry' },
        })).toMatchObject({ success: true });
        const failure = new Error('changed since review');
        await expect(f.backend.worktreeReinstate!({ context: { ...f.context, beforeFilesystemMutation: async () => {
            expect(scmWorktreeMutationActivity.isIdle()).toBe(false);
            throw failure;
        } }, request: { worktreePath: f.payload, targetPath: f.first, entryId: 'entry' } })).rejects.toBe(failure);
        expect(scmWorktreeMutationActivity.isIdle()).toBe(true);
        expect(git(f.root, 'worktree', 'list', '--porcelain')).toContain('locked happier-trash:entry');
        expect(await f.backend.worktreeReinstate!({ context: f.context,
            request: { worktreePath: f.payload, targetPath: f.first, entryId: 'entry' },
        })).toMatchObject({ success: true });
        expect(git(f.first, 'status', '--porcelain')).toBe('');
        expect(scmWorktreeMutationActivity.isIdle()).toBe(true);
    });
});
