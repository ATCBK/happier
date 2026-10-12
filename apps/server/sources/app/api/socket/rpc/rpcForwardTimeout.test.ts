import { describe, expect, it } from 'vitest';
import { resolveRpcForwardTimeoutMs } from './rpcForwardTimeout';
import { loadStartupHomeEnv } from '@/app/home/settings/startupHomeEnv';

describe('resolveRpcForwardTimeoutMs', () => {
    it('uses the configured default only when the caller omits the deadline', async () => {
        await loadStartupHomeEnv({
            env: {},
            readStored: async () => ({ values: {
                HAPPIER_RPC_FORWARD_TIMEOUT_MS: 45_000,
                HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS: 150_000,
                HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS: 400_000,
            }, secrets: {} }),
            log: () => {},
        });
        try {
            expect(resolveRpcForwardTimeoutMs()).toBe(45_000);
            expect(resolveRpcForwardTimeoutMs(500_000)).toBe(500_000);
            expect(resolveRpcForwardTimeoutMs(null)).toBeNull();
        } finally {
            await loadStartupHomeEnv({ env: {}, readStored: async () => ({ values: {}, secrets: {} }), log: () => {} });
        }
    });

    it('honors short and long explicit caller deadlines', () => {
        expect(resolveRpcForwardTimeoutMs(1)).toBe(1);
        expect(resolveRpcForwardTimeoutMs(0.5)).toBe(0.5);
        expect(resolveRpcForwardTimeoutMs(20 * 60_000)).toBe(20 * 60_000);
    });

    it('preserves explicit null and deadlines beyond the native Socket.IO timer boundary', () => {
        expect(resolveRpcForwardTimeoutMs(null)).toBeNull();
        expect(resolveRpcForwardTimeoutMs(2_147_483_648)).toBe(2_147_483_648);
    });
});
