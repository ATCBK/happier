import {
    mkdir,
    mkdtemp,
    rm,
    realpath,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { FSWatcher, WatchListener, WatchOptions } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startDirectoryTopologyWatcher } from './startDirectoryTopologyWatcher';

describe('startDirectoryTopologyWatcher', () => {
    let testDirectory: string;
    beforeEach(async () => {
        testDirectory = await realpath(await mkdtemp(join(tmpdir(), 'directory-topology-boundary-')));
    });
    afterEach(async () => {
        await rm(testDirectory, { recursive: true, force: true });
        vi.useRealTimers();
    });

    it('reports a failed target attachment without owning retry timing or structural catch-up', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout'],
        });
        let targetAttempts = 0;
        const watchImpl = vi.fn((
            _path: string,
            options: WatchOptions,
            listener: WatchListener<string>,
        ): FSWatcher => {
            if (options.recursive !== undefined) {
                targetAttempts += 1;
                if (targetAttempts === 1) {
                    const error = new Error(
                        'descriptor limit',
                    ) as NodeJS.ErrnoException;
                    error.code = 'EMFILE';
                    throw error;
                }
            }
            return {
                close: vi.fn(),
                on: vi.fn().mockReturnThis(),
            } as unknown as FSWatcher;
        });
        const onStructuralChange = vi.fn();
        const onReady = vi.fn();
        const onUnavailable = vi.fn();
        const dispose = startDirectoryTopologyWatcher(
            testDirectory,
            onStructuralChange,
            { watchImpl, onReady, onUnavailable },
        );

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await vi.waitFor(() => expect(targetAttempts).toBe(1));
        expect(onUnavailable).toHaveBeenCalledOnce();
        expect(onReady).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(onStructuralChange).not.toHaveBeenCalled();
        dispose();
    });

    it('coalesces repeated target watcher errors into one unavailable notification without retrying locally', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout'],
        });
        let targetError: (() => void) | undefined;
        let targetAttempts = 0;
        const firstTargetClose = vi.fn();
        const watchImpl = vi.fn((
            _path: string,
            options: WatchOptions,
            _listener: WatchListener<string>,
        ): FSWatcher => {
            if (options.recursive === undefined) {
                return {
                    close: vi.fn(),
                    on: vi.fn().mockReturnThis(),
                } as unknown as FSWatcher;
            }
            targetAttempts += 1;
            const watcher = {
                close: targetAttempts === 1 ? firstTargetClose : vi.fn(),
                on: vi.fn((event: string, listener: () => void) => {
                    if (event === 'error' && targetAttempts === 1) {
                        targetError = listener;
                    }
                    return watcher;
                }),
            } as unknown as FSWatcher;
            return watcher;
        });
        const onStructuralChange = vi.fn();
        const onReady = vi.fn();
        const onUnavailable = vi.fn();
        const dispose = startDirectoryTopologyWatcher(
            testDirectory,
            onStructuralChange,
            { watchImpl, onReady, onUnavailable },
        );

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await vi.waitFor(() => expect(targetAttempts).toBe(1));
        await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
        targetError?.();
        targetError?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));

        await vi.waitFor(() => expect(targetAttempts).toBe(1));
        expect(firstTargetClose).toHaveBeenCalledOnce();
        expect(onUnavailable).toHaveBeenCalledOnce();
        expect(onStructuralChange).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        dispose();
    });

    it('reports a failed parent sentinel without owning retry timing or structural catch-up', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout'],
        });
        let parentError: (() => void) | undefined;
        let parentAttempts = 0;
        const firstParentClose = vi.fn();
        const watchImpl = vi.fn((
            _path: string,
            options: WatchOptions,
            _listener: WatchListener<string>,
        ): FSWatcher => {
            if (options.recursive !== undefined) {
                return {
                    close: vi.fn(),
                    on: vi.fn().mockReturnThis(),
                } as unknown as FSWatcher;
            }
            parentAttempts += 1;
            const watcher = {
                close: parentAttempts === 1 ? firstParentClose : vi.fn(),
                on: vi.fn((event: string, listener: () => void) => {
                    if (event === 'error' && parentAttempts === 1) {
                        parentError = listener;
                    }
                    return watcher;
                }),
            } as unknown as FSWatcher;
            return watcher;
        });
        const onStructuralChange = vi.fn();
        const onReady = vi.fn();
        const onUnavailable = vi.fn();
        const dispose = startDirectoryTopologyWatcher(
            testDirectory,
            onStructuralChange,
            { watchImpl, onReady, onUnavailable },
        );

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(parentAttempts).toBe(1);
        await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
        parentError?.();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(parentAttempts).toBe(1);
        expect(firstParentClose).toHaveBeenCalledOnce();
        expect(onUnavailable).toHaveBeenCalledOnce();
        expect(onStructuralChange).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        dispose();
    });

    it('fences a queued unavailable notification when disposed during failed attachment', async () => {
        vi.useFakeTimers();
        let targetAttempts = 0;
        let dispose = () => {};
        const watchImpl = vi.fn((
            _path: string,
            options: WatchOptions,
            _listener: WatchListener<string>,
        ): FSWatcher => {
            if (options.recursive !== undefined) {
                targetAttempts += 1;
                void Promise.resolve().then(() => dispose());
                const error = new Error('descriptor limit') as NodeJS.ErrnoException;
                error.code = 'EMFILE';
                throw error;
            }
            return {
                close: vi.fn(),
                on: vi.fn().mockReturnThis(),
            } as unknown as FSWatcher;
        });
        const onStructuralChange = vi.fn();
        const onUnavailable = vi.fn();
        dispose = startDirectoryTopologyWatcher(
            testDirectory,
            onStructuralChange,
            { watchImpl, onUnavailable },
        );

        await Promise.resolve();
        await vi.waitFor(() => expect(targetAttempts).toBe(1));
        dispose();
        await Promise.resolve();
        expect(onUnavailable).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);

        await vi.waitFor(() => expect(targetAttempts).toBe(1));
        expect(onStructuralChange).not.toHaveBeenCalled();
        dispose();
    });

    it('reports recursive structural candidates while filtering exact-file content notifications', async () => {
        let recursiveListener: WatchListener<string> | undefined;
        const watchImpl = vi.fn((
            _path: string,
            options: WatchOptions,
            listener: WatchListener<string>,
        ): FSWatcher => {
            if (options.recursive !== undefined) {
                recursiveListener = listener;
            }
            return {
                close: vi.fn(),
                on: vi.fn().mockReturnThis(),
            } as unknown as FSWatcher;
        });
        const onStructuralChange = vi.fn();
        const dispose = startDirectoryTopologyWatcher(
            testDirectory,
            onStructuralChange,
            { watchImpl },
        );
        await vi.waitFor(() => expect(recursiveListener).toBeDefined());

        recursiveListener?.('change', 'existing.jsonl');
        expect(onStructuralChange).not.toHaveBeenCalled();

        recursiveListener?.('rename', join('2026', '07', '25', 'child.jsonl'));
        await vi.waitFor(() => expect(onStructuralChange).toHaveBeenCalledOnce());
        expect(onStructuralChange).toHaveBeenCalledWith(
            join(testDirectory, '2026', '07', '25', 'child.jsonl'),
        );

        dispose();
    });

    it('disposes idempotently and fences later events', async () => {
        const root = await realpath(
            await mkdtemp(join(tmpdir(), 'directory-topology-watcher-dispose-')),
        );
        const onStructuralChange = vi.fn();
        const watchImpl = vi.fn((
            _path: string,
            _options: WatchOptions,
            _listener: WatchListener<string>,
        ): FSWatcher => ({
            close: vi.fn(),
            on: vi.fn().mockReturnThis(),
        } as unknown as FSWatcher));
        const dispose = startDirectoryTopologyWatcher(
            root,
            onStructuralChange,
            { watchImpl },
        );

        dispose();
        dispose();
        await writeFile(join(root, 'late.jsonl'), '{}\n', 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(onStructuralChange).not.toHaveBeenCalled();
    });

    it('reports creation of an initially missing directory even when its child appears immediately', async () => {
        const parent = await realpath(
            await mkdtemp(join(tmpdir(), 'directory-topology-watcher-missing-')),
        );
        const root = join(parent, 'archived_sessions');
        let parentListener: WatchListener<string> | undefined;
        let recursiveAttachments = 0;
        const watchImpl = vi.fn((
            _path: string,
            options: WatchOptions,
            listener: WatchListener<string>,
        ): FSWatcher => {
            if (options.recursive !== undefined) {
                recursiveAttachments += 1;
            } else {
                parentListener = listener;
            }
            return {
                close: vi.fn(),
                on: vi.fn().mockReturnThis(),
            } as unknown as FSWatcher;
        });
        const onStructuralChange = vi.fn();
        const dispose = startDirectoryTopologyWatcher(
            root,
            onStructuralChange,
            { watchImpl },
        );
        await Promise.resolve();
        expect(recursiveAttachments).toBe(0);

        await mkdir(join(root, '2026', '07', '25'), { recursive: true });
        await writeFile(join(root, '2026', '07', '25', 'child.jsonl'), '{}\n', 'utf8');
        parentListener?.('rename', 'archived_sessions');

        await vi.waitFor(() => expect(onStructuralChange).toHaveBeenCalled());
        expect(recursiveAttachments).toBe(process.platform === 'darwin' || process.platform === 'win32' ? 1 : 4);
        dispose();
    });

    it('reports delete and recreation while refusing to attach recursively through a recreated symlink', async () => {
        const parent = await realpath(
            await mkdtemp(join(tmpdir(), 'directory-topology-watcher-recreate-')),
        );
        const root = join(parent, 'sessions');
        const outside = join(parent, 'outside');
        await mkdir(root);
        await mkdir(outside);
        let parentListener: WatchListener<string> | undefined;
        let recursiveListener: WatchListener<string> | undefined;
        let recursiveAttachments = 0;
        const watchImpl = vi.fn((
            _path: string,
            options: WatchOptions,
            listener: WatchListener<string>,
        ): FSWatcher => {
            if (options.recursive !== undefined) {
                recursiveAttachments += 1;
                recursiveListener = listener;
            } else {
                parentListener = listener;
            }
            return {
                close: vi.fn(),
                on: vi.fn().mockReturnThis(),
            } as unknown as FSWatcher;
        });
        const onStructuralChange = vi.fn();
        const dispose = startDirectoryTopologyWatcher(
            root,
            onStructuralChange,
            { watchImpl },
        );
        await vi.waitFor(() => expect(recursiveAttachments).toBe(1));

        await rm(root, { recursive: true });
        parentListener?.('rename', 'sessions');
        await vi.waitFor(() => expect(onStructuralChange).toHaveBeenCalledOnce());
        expect(recursiveAttachments).toBe(1);
        onStructuralChange.mockClear();

        await symlink(outside, root, 'dir');
        parentListener?.('rename', 'sessions');
        await vi.waitFor(() => expect(onStructuralChange).toHaveBeenCalledOnce());
        expect(recursiveAttachments).toBe(1);
        onStructuralChange.mockClear();
        await writeFile(join(outside, 'must-not-be-observed.jsonl'), '{}\n', 'utf8');
        expect(onStructuralChange).not.toHaveBeenCalled();

        await rm(root);
        await mkdir(root);
        await writeFile(join(root, 'recreated-child.jsonl'), '{}\n', 'utf8');
        parentListener?.('rename', 'sessions');
        await vi.waitFor(() => expect(recursiveAttachments).toBe(2));
        expect(onStructuralChange).toHaveBeenCalledOnce();
        onStructuralChange.mockClear();
        recursiveListener?.('rename', 'recreated-child.jsonl');
        await vi.waitFor(() => expect(onStructuralChange).toHaveBeenCalledWith(
            join(root, 'recreated-child.jsonl'),
        ));
        dispose();
    });
});
