import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execOrThrow, stageProcessCustodyRuntime } from '@happier-dev/cli-common/componentArtifacts';
import { resolveNativeCustodyTarget } from '../test-setup';

/** Stage the prepared checkout-native helper at the real runtime asset boundary. */
export async function createProcessCustodyFixture(input: Readonly<{ repoRoot?: string }> = {}): Promise<() => Promise<void>> {
    const originalExecutable = Object.getOwnPropertyDescriptor(process, 'execPath')!;
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-process-custody-fixture-')));
    const payload = join(scratch, 'native');
    try {
        const repoRoot = input.repoRoot ?? resolve('../..');
        const { target, executablePath } = resolveNativeCustodyTarget(join(repoRoot, 'apps', 'cli'));
        await stageProcessCustodyRuntime({ repoRoot, payloadDir: payload, target,
            prebuiltExecutablePath: executablePath, runCommand: execOrThrow,
        });
        Object.defineProperty(process, 'execPath', { ...originalExecutable, value: join(payload, 'happier') });
    } catch (error) { await rm(scratch, { recursive: true, force: true }); throw error; }
    return async () => {
        Object.defineProperty(process, 'execPath', originalExecutable);
        await rm(scratch, { recursive: true, force: true });
    };
}
