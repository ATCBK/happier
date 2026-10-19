import { EventEmitter, on } from 'node:events';
import { statSync, watch } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { logger } from '@/ui/logger';

const WATCH_RECOVERY_DELAY_MS = 1_000;

export type StartFileWatcherOptions = Readonly<{
    emitInitial?: boolean;
    reportEventPath?: boolean;
    onWatcherAttached?: () => void;
    onWatcherUnavailable?: (error: Error) => void;
}>;

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function delayUnrefAbortable(ms: number, abortSignal: AbortSignal): Promise<void> {
    if (abortSignal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            abortSignal.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        timer.unref?.();
        abortSignal.addEventListener('abort', finish, { once: true });
    });
}

function version(entry: Awaited<ReturnType<typeof stat>>): string {
    return `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeMs}`;
}

function readRegistration(file: string): Readonly<{ version: string | null; isDirectory: boolean }> {
    try {
        const entry = statSync(file);
        return { version: version(entry), isDirectory: entry.isDirectory() };
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { version: null, isDirectory: false };
        throw error;
    }
}

async function readEntry(file: string) {
    try {
        return await stat(file);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null;
        throw error;
    }
}

async function readVersion(file: string): Promise<string | null> {
    const entry = await readEntry(file);
    return entry ? version(entry) : null;
}

function identity(fileVersion: string | null): string | null {
    return fileVersion?.split(':', 2).join(':') ?? null;
}

async function isFileSymlink(file: string): Promise<boolean> {
    try {
        return (await lstat(file)).isSymbolicLink();
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return false;
        throw error;
    }
}

type DirectoryObservation = {
    identity: string | null;
    watcher: ReturnType<typeof watch>;
    subscribers: Map<string | null, Set<EventEmitter>>;
};

const directoryObservations = new Map<string, DirectoryObservation>();

/** Native transcript files share parent observation, not delivery or recovery. */
function observeDirectory(directory: string, directoryVersion: string, targetName: string | null) {
    let observation = directoryObservations.get(directory);
    if (!observation || observation.identity !== identity(directoryVersion)) {
        const next: DirectoryObservation = {
            identity: identity(directoryVersion),
            watcher: watch(directory, { persistent: true }),
            subscribers: new Map(),
        };
        directoryObservations.set(directory, next);
        const forget = () => {
            if (directoryObservations.get(directory) === next) directoryObservations.delete(directory);
        };
        next.watcher.on('change', (eventType, filename) => {
            // A parent rename can replace the directory itself, so all logical
            // watchers must revalidate its identity. Ordinary appends dispatch
            // only to the named file and directory observers, not the corpus.
            const name = typeof filename === 'string' && filename ? filename : null;
            const groups = eventType === 'rename' || name === null
                ? next.subscribers.values()
                : [next.subscribers.get(name), next.subscribers.get(null)];
            for (const group of groups) for (const events of group ?? []) events.emit('change', eventType, filename);
        });
        next.watcher.on('error', error => {
            forget();
            for (const group of next.subscribers.values()) for (const events of group) events.emit('error', error);
        });
        next.watcher.on('close', () => {
            forget();
            for (const group of next.subscribers.values()) for (const events of group) events.emit('close');
        });
        logger.debug('[FILE_WATCHER] Starting watcher');
        observation = next;
    }
    const current = observation;
    const events = new EventEmitter();
    const group = current.subscribers.get(targetName) ?? new Set<EventEmitter>();
    group.add(events);
    current.subscribers.set(targetName, group);
    let active = true;
    return {
        events,
        close() {
            if (!active) return;
            active = false;
            group.delete(events);
            if (group.size === 0) current.subscribers.delete(targetName);
            events.emit('close');
            if (current.subscribers.size === 0) {
                if (directoryObservations.get(directory) === current) directoryObservations.delete(directory);
                current.watcher.close();
            }
        },
    };
}

export function startFileWatcher(
    file: string,
    onFileChange: (file: string) => void | Promise<void>,
    options?: StartFileWatcherOptions,
) {
    const abortController = new AbortController();
    const registration = readRegistration(file);
    const targetName = basename(file);
    let isDirectory = registration.isDirectory;
    let attachmentCount = 0;
    let unavailable = false;
    const reportUnavailable = (error: unknown) => {
        if (abortController.signal.aborted || unavailable) return;
        unavailable = true;
        options?.onWatcherUnavailable?.(error instanceof Error ? error : new Error('File watcher unavailable'));
    };

    void (async () => {
        while (!abortController.signal.aborted) {
            let closeWatcher: (() => void) | undefined;
            try {
                const currentEntry = await readEntry(file);
                if (currentEntry) isDirectory = currentEntry.isDirectory();
                const isSymlink = !isDirectory && await isFileSymlink(file);
                const watchedDirectory = isDirectory ? file : dirname(file);
                const directoryVersion = await readVersion(watchedDirectory);
                if (directoryVersion === null) {
                    if (!unavailable) logger.debug('[FILE_WATCHER] Parent directory missing; waiting for recovery');
                    reportUnavailable(new Error('File watcher parent directory missing'));
                    await delayUnrefAbortable(WATCH_RECOVERY_DELAY_MS, abortController.signal);
                    continue;
                }

                // Watch the parent of a file so replacement/deletion keeps the
                // same native observation. fs.watch attaches synchronously;
                // readiness must not be reported before native attachment.
                const parent = observeDirectory(watchedDirectory, directoryVersion, isDirectory ? null : targetName);
                const watcher = parent.events;
                closeWatcher = () => parent.close();
                const events = on(watcher, 'change', {
                    signal: abortController.signal,
                    close: ['close'],
                });
                // Parent events cover the logical entry. A symlink's content
                // can change outside that directory, so retain native target
                // observation within this same attachment and recovery owner.
                const targetWatcher = isSymlink ? watch(file, { persistent: true }) : null;
                let closing = false;
                closeWatcher = () => {
                    closing = true;
                    targetWatcher?.close();
                    parent.close();
                };
                targetWatcher?.on('change', (eventType) => {
                    if (!closing) watcher.emit('change', eventType, targetName);
                });
                targetWatcher?.on('error', (error) => {
                    if (!closing) watcher.emit('error', error);
                });
                targetWatcher?.on('close', () => {
                    if (!closing) watcher.emit('close');
                });
                abortController.signal.addEventListener('abort', closeWatcher, { once: true });
                if (abortController.signal.aborted) {
                    closeWatcher();
                    return;
                }
                const attachedEntry = await readEntry(file);
                if (abortController.signal.aborted) return;
                const currentVersion = attachedEntry ? version(attachedEntry) : null;
                const changedBeforeFirstAttachment = attachmentCount === 0 && currentVersion !== registration.version;
                if (
                    (options?.emitInitial !== false && currentVersion !== null)
                    || attachmentCount > 0
                    || changedBeforeFirstAttachment
                ) {
                    await onFileChange(file);
                }
                if (abortController.signal.aborted) return;
                if (!isDirectory && attachedEntry?.isDirectory()) {
                    reportUnavailable(new Error('File watcher directory appeared'));
                    continue;
                }
                if (!isDirectory && await isFileSymlink(file) !== isSymlink) {
                    reportUnavailable(new Error('File watcher symlink changed during attachment'));
                    continue;
                }
                if (abortController.signal.aborted) return;
                attachmentCount += 1;
                unavailable = false;
                options?.onWatcherAttached?.();
                for await (const rawEvent of events) {
                    if (abortController.signal.aborted) return;
                    // EventEmitter's untyped boundary is narrowed immediately.
                    const event: readonly unknown[] = rawEvent;
                    const name = typeof event[1] === 'string' ? event[1] : '';
                    if (!isDirectory && name && name !== targetName && event[0] !== 'rename') continue;
                    const currentDirectoryVersion = await readVersion(watchedDirectory);
                    if (abortController.signal.aborted) return;
                    if (identity(currentDirectoryVersion) !== identity(directoryVersion)) {
                        reportUnavailable(new Error('File watcher directory replaced'));
                        await onFileChange(file);
                        break;
                    }
                    if (!isDirectory && name && name !== targetName) continue;
                    logger.debug('[FILE_WATCHER] Watched file changed');
                    await onFileChange(
                        options?.reportEventPath === true && isDirectory && name
                            ? resolve(file, name)
                            : file,
                    );
                    if (!isDirectory && event[0] === 'rename' && (await readEntry(file))?.isDirectory()) {
                        reportUnavailable(new Error('File watcher directory appeared'));
                        break;
                    }
                    if (!isDirectory && (
                        (isSymlink && (event[0] === 'rename' || identity(await readVersion(file)) !== identity(currentVersion)))
                        || (event[0] === 'rename' && await isFileSymlink(file) !== isSymlink)
                    )) {
                        reportUnavailable(new Error('File watcher symlink target changed'));
                        break;
                    }
                }
                reportUnavailable(new Error('File watcher detached'));
            } catch (error) {
                if (abortController.signal.aborted) return;
                reportUnavailable(error);
                logger.debug(`[FILE_WATCHER] Watch error; restarting watcher in ${WATCH_RECOVERY_DELAY_MS}ms`);
            } finally {
                if (closeWatcher) {
                    abortController.signal.removeEventListener('abort', closeWatcher);
                    closeWatcher();
                }
            }
            await delayUnrefAbortable(WATCH_RECOVERY_DELAY_MS, abortController.signal);
        }
    })();

    return () => {
        abortController.abort();
    };
}
