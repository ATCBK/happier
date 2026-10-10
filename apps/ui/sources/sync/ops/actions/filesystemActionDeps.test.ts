import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createUiFilesystemAction } from './filesystemActionDeps';

const transport = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ success: false, error: 'Destination already exists' })));
// Machine RPC is the genuine cross-process boundary; Action admission remains real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({ callGuardedMachineRpcWithPolicy: transport }));

describe('UI filesystem Action transport', () => {
    it('preserves the addressed Home, machine, root and explicit conflict choice', async () => {
        const input = { rootPath: '/repo', from: 'a', to: 'b', overwrite: false };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.rename'), input, {
            serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' },
            surface: 'ui', authority: 'present_user',
        })).toEqual({ ok: true, result: { success: false, error: 'Destination already exists' } });
        expect(transport).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'home', accountId: 'account', machineId: 'machine',
            method: 'daemon.filesystem.rename', payload: input }));
    });
    it('does not infer a machine target from the ambient session', async () => {
        transport.mockClear();
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.createDirectory'), { rootPath: '/repo', path: 'folder' }, {
            surface: 'ui', authority: 'present_user', serverId: 'home', defaultSessionId: 'ambient',
        })).toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
        expect(transport).not.toHaveBeenCalled();
    });
    it('refuses a generic transfer without concrete byte custody before preparing', async () => {
        transport.mockClear();
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.download'), {
            rootPath: '/repo', path: 'binary', destination: { destinationId: 'arbitrary' }, asZip: false,
        }, { surface: 'ui', authority: 'present_user', externalActionTarget: { kind: 'machine', machineId: 'machine' } }))
            .toMatchObject({ ok: false, errorCode: 'filesystem_transfer_custody_required' });
        expect(transport).not.toHaveBeenCalled();
    });
    it('rejects a cross-target copy whose destination differs from the admitted Action address', async () => {
        transport.mockClear();
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        expect(await executor.execute('daemon.filesystem.copy', { kind: 'target_copy',
            source: { serverId: 'source-home', machineId: 'source', rootPath: '/source', path: 'file' },
            destination: { serverId: 'other-home', machineId: 'other', rootPath: '/destination', path: 'copy' },
            overwrite: false, recursive: false,
        }, { serverId: 'home', runtimeAccountId: 'account', surface: 'ui', authority: 'present_user',
            externalActionTarget: { kind: 'machine', machineId: 'machine' } }))
            .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(transport).not.toHaveBeenCalled();
    });
    it('refuses to acquire cross-target bytes without a captured destination Account', async () => {
        transport.mockClear();
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ filesystemActionExecute: createUiFilesystemAction() }));
        expect(await executor.execute('daemon.filesystem.copy', { kind: 'target_copy',
            source: { serverId: 'source-home', machineId: 'source', rootPath: '/source', path: 'file' },
            destination: { serverId: 'home', machineId: 'machine', rootPath: '/destination', path: 'copy' },
            overwrite: false, recursive: false,
        }, { serverId: 'home', runtimeAccountId: 'account', surface: 'ui', authority: 'present_user',
            externalActionTarget: { kind: 'machine', machineId: 'machine' } }))
            .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(transport).not.toHaveBeenCalled();
    });
});
