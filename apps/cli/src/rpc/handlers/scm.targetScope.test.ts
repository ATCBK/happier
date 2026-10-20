import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScmBranchListResponseSchema, ScmRemoteResponseSchema, ScmStatusSnapshotResponseSchema } from '@happier-dev/protocol/scm';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { createScmBackendRegistry } from '@/scm/registry';
import { createTestRpcManager } from '@/scm/rpc/__tests__/testRpcHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('registered SCM target scope', () => {
    it('refuses a Machine-denied project root before optional-cwd dispatch, preserving valid and raw defaults', async () => {
        await withTempDir('scm-target-scope-', async directory => {
            const machineId = 'scm-scope-machine';
            const workingDirectory = join(directory, 'daemon');
            const projectDirectory = join(directory, 'project');
            const deniedDirectory = join(directory, 'outside-policy');
            await Promise.all([workingDirectory, projectDirectory, deniedDirectory].map(path => mkdir(path)));
            const receiver = createTestRpcManager({
                machineId,
                workingDirectory,
                registry: createScmBackendRegistry([]),
                accessPolicy: { kind: 'restrictedRoots', roots: [workingDirectory, projectDirectory] },
            });
            const target = (root: string) => ({ kind: 'machine' as const, machineId,
                project: { machineId, directory: root } });

            for (const input of [{}, { cwd: '' }, { cwd: workingDirectory }]) {
                const response = ScmStatusSnapshotResponseSchema.parse(await receiver.call(
                    RPC_METHODS.SCM_STATUS_SNAPSHOT,
                    createTargetedActionRpcRequestV1(input, target(deniedDirectory)),
                ));
                expect.soft(response, `denied root with ${JSON.stringify(input)}`)
                    .toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
            }

            // Other optional-cwd reads and mutations share the receiving registrar.
            // An empty real registry cannot mutate any repository if dispatch leaks.
            for (const method of [RPC_METHODS.SCM_BRANCH_LIST, RPC_METHODS.SCM_REMOTE_FETCH]) {
                for (const input of [{}, { cwd: '' }]) {
                    const result = await receiver.call(method, createTargetedActionRpcRequestV1(input, target(deniedDirectory)));
                    const response = method === RPC_METHODS.SCM_BRANCH_LIST
                        ? ScmBranchListResponseSchema.parse(result) : ScmRemoteResponseSchema.parse(result);
                    expect.soft(response, `${method} with ${JSON.stringify(input)}`)
                        .toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
                }
            }

            for (const input of [{}, { cwd: '' }]) {
                const scoped = ScmStatusSnapshotResponseSchema.parse(await receiver.call(
                    RPC_METHODS.SCM_STATUS_SNAPSHOT, createTargetedActionRpcRequestV1(input, target(projectDirectory)),
                ));
                expect(scoped).toMatchObject({ success: true,
                    snapshot: { projectKey: `${projectDirectory}:${projectDirectory}` } });
                const raw = ScmStatusSnapshotResponseSchema.parse(await receiver.call(RPC_METHODS.SCM_STATUS_SNAPSHOT, input));
                expect(raw).toMatchObject({ success: true,
                    snapshot: { projectKey: `${workingDirectory}:${workingDirectory}` } });
            }
        });
    });
});
