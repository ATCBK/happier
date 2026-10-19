import { spawn } from 'node:child_process';

import { z } from 'zod/mini';

import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';

const resultSchema = z.discriminatedUnion('status', [
    z.strictObject({ v: z.literal(1), status: z.literal('renamed') }),
    z.strictObject({ v: z.literal(1), status: z.literal('failed'), code: z.enum(['destination_occupied', 'storage_rename_failed', 'changed_since_review']), message: z.string() }),
]);

function cancelled(): Error {
    return Object.assign(new Error('Storage rename cancelled'), { name: 'AbortError' });
}

/** The native OS rename owns the no-replacement decision, including racing writers. */
export async function renameStoragePathNoReplace(sourcePath: string, targetPath: string, signal?: AbortSignal, expectedIdentity?: Readonly<{ dev: string; ino: string }>): Promise<void> {
    if (signal?.aborted) throw cancelled();
    const executable = resolveProcessCustodySupportExecutable();
    if (!executable) throw Object.assign(new Error('Native storage rename is unavailable'), { code: 'native_storage_unavailable' });
    const child = spawn(executable, ['storage-rename'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const fail = (error: Error) => {
        failure ??= error;
        child.kill('SIGKILL');
    };
    const cancel = () => fail(cancelled());
    await new Promise<void>((resolve, reject) => {
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });
        child.stdout.on('error', fail);
        child.stderr.on('error', fail);
        child.stdin.on('error', fail);
        child.on('error', (error) => { failure ??= error; });
        child.on('close', (exitCode) => {
            signal?.removeEventListener('abort', cancel);
            if (failure) { reject(failure); return; }
            if (exitCode !== 0) {
                reject(Object.assign(new Error(stderr.trim() || 'Native storage rename failed'), { code: 'storage_rename_failed', exitCode }));
                return;
            }
            try {
                const result = resultSchema.parse(JSON.parse(stdout));
                if (result.status === 'failed') {
                    reject(Object.assign(new Error(result.message), { code: result.code }));
                } else resolve();
            } catch (cause) {
                reject(Object.assign(new Error('Invalid native storage rename output', { cause }), { code: 'invalid_native_storage_output' }));
            }
        });
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        else child.stdin.end(JSON.stringify({ sourcePath, targetPath, expectedIdentity: expectedIdentity
            ? { dev: expectedIdentity.dev, ino: expectedIdentity.ino }
            : undefined }));
    });
}
