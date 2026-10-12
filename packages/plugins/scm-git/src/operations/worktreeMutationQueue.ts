import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const pending = new Map<string, Promise<void>>();
async function repositoryKey(cwd: string): Promise<string> {
    let current = resolve(cwd);
    for (;;) {
        try {
            const dotGit = join(current, '.git');
            let common = dotGit;
            try {
                const text = await readFile(dotGit, 'utf8');
                if (text.startsWith('gitdir:')) {
                    const path = text.slice(7).trim();
                    const admin = isAbsolute(path) ? path : resolve(current, path);
                    const relativeCommon = (await readFile(join(admin, 'commondir'), 'utf8')).trim();
                    common = resolve(admin, relativeCommon);
                }
            } catch { /* A main checkout has a directory at .git. */ }
            const physical = await realpath(common);
            return process.platform === 'win32' ? physical.toLowerCase() : physical;
        } catch {
            const parent = dirname(current);
            if (parent === current) return resolve(cwd);
            current = parent;
        }
    }
}

/** One queue for the shared Git admin directory; unrelated repositories proceed independently. */
export async function withGitWorktreeMutation<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    const key = await repositoryKey(cwd);
    const previous = pending.get(key) ?? Promise.resolve();
    let release!: () => void;
    const settled = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => settled);
    pending.set(key, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (pending.get(key) === tail) pending.delete(key); }
}
