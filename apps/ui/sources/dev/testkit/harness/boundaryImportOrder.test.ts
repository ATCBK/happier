import { describe, expect, it } from 'vitest';

// Reproduce a screen's static import graph before its suite installs boundaries.
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { renderScreen } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from './homeGovernanceHarness';
import { createProviderSettingsHarness, installProviderSettingsRpcBoundary } from './providerSettingsHarness';

describe('transport boundary import order', () => {
    it('rejects HTTP installation after a static consumer has captured the real transport', () => {
        expect(typeof createServerFetchAtEndpoint).toBe('function');
        expect(typeof renderScreen).toBe('function');
        expect(() => installHomeGovernanceBoundaries(createHomeGovernanceHarness())).toThrowError(
            /installHomeGovernanceBoundaries.*@\/sync\/http\/client.*before.*dynamic import/s,
        );
    });

    it('rejects RPC installation after a static consumer has captured the disconnected transport', () => {
        expect(typeof machineRpcWithServerScope).toBe('function');
        expect(() => installProviderSettingsRpcBoundary(createProviderSettingsHarness())).toThrowError(
            /installProviderSettingsRpcBoundary.*serverScopedMachineRpc.*before.*dynamic import/s,
        );
    });
});
