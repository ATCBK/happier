import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CLI_BINARY_TARGETS, resolveCurrentBinaryTarget, stageProcessCustodyRuntime } from '@happier-dev/cli-common/componentArtifacts';

/** Stage the current source-native helper at the real runtime asset boundary. */
export async function createProcessCustodyFixture(): Promise<() => Promise<void>> {
    const originalExecutable = Object.getOwnPropertyDescriptor(process, 'execPath')!;
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-process-custody-fixture-')));
    const payload = join(scratch, 'native');
    try {
        await stageProcessCustodyRuntime({ repoRoot: resolve('../..'), payloadDir: payload,
            target: resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
            runCommand: async (command, args, options) => { await promisify(execFile)(command, args, { cwd: options?.cwd, env: options?.env }); },
        });
        Object.defineProperty(process, 'execPath', { ...originalExecutable, value: join(payload, 'happier') });
    } catch (error) { await rm(scratch, { recursive: true, force: true }); throw error; }
    return async () => {
        Object.defineProperty(process, 'execPath', originalExecutable);
        await rm(scratch, { recursive: true, force: true });
    };
}
