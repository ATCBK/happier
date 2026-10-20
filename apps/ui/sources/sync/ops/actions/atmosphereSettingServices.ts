import type { SettingsMutationServices } from '@/components/settings/catalog/settingDeclarations';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

/** Settings adapters retain the invocation's exact Account; filesystem admission remains daemon-owned. */
export function createAtmosphereSettingServices(account: Parameters<typeof createUiProjectAccountRowsClient>[0]
    & Partial<Pick<LazyActionAccountContext, 'accountLifetime' | 'invocationSignal'>>): Pick<SettingsMutationServices, 'projectAccountRows' | 'readAtmospherePictureFile'> {
    return {
        projectAccountRows: createUiProjectAccountRowsClient(account),
        readAtmospherePictureFile: async (input, signal) => {
            throwIfAborted(signal); account.assertCurrent();
            const result = await withActionAccountRequestSignal(account, signal, ownedSignal => callGuardedMachineRpcWithPolicy<unknown, Readonly<{ path: string }>>({
                machineId: input.machineId, serverId: account.serverId, accountId: account.accountId,
                method: 'readFile', payload: { path: input.path }, signal: ownedSignal,
            }));
            account.assertCurrent();
            if (result && typeof result === 'object' && 'success' in result) {
                if (result.success === true && 'content' in result && typeof result.content === 'string') return { success: true, content: result.content };
                if (result.success === false && 'error' in result && typeof result.error === 'string') return { success: false, error: result.error };
            }
            return { success: false, error: 'picture_file_response_invalid' };
        },
    };
}
