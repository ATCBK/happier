import { describe, expect, it, vi } from 'vitest';

const machineTransport = vi.hoisted(() => vi.fn());
// Only the remote Machine transport is replaced; authorization routing and the Settings adapter remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineTransport }));

import { createAtmosphereSettingServices } from './atmosphereSettingServices';

describe('atmosphere Settings Machine acquisition', () => {
    it('reads exact Account Machine bytes with the native AbortSignal contract and rejects an aborted read', async () => {
        const controller = new AbortController();
        Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
        machineTransport.mockResolvedValue({ success: true, content: 'AP+AAw==' });
        const services = createAtmosphereSettingServices({ serverId: 'home-a', accountId: 'account-a', credentials: { token: 'plain-token' },
            assertCurrent: () => {}, resolveAccountEncryption: async () => ({ accountMode: 'plain', encryption: null }),
            request: async () => { throw new Error('unexpected_http'); } });
        expect(await services.readAtmospherePictureFile?.({ machineId: 'machine-a', path: 'C:\\pictures\\photo.png' }, controller.signal))
            .toEqual({ success: true, content: 'AP+AAw==' });
        expect(machineTransport.mock.calls[0]?.[0]).toMatchObject({ serverId: 'home-a', accountId: 'account-a', machineId: 'machine-a',
            method: 'readFile', payload: { path: 'C:\\pictures\\photo.png' } });
        controller.abort();
        await expect(services.readAtmospherePictureFile?.({ machineId: 'machine-a', path: 'C:\\pictures\\photo.png' }, controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(machineTransport.mock.calls).toHaveLength(1);
    });
});
