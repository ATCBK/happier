import { describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { prepareDaemonMachineIrohRuntime } from './prepareDaemonMachineIrohRuntime';

// The native addon loader is an external OS boundary, not the runtime factory.
vi.mock('@happier-dev/iroh-native/node', async importOriginal => ({
  ...await importOriginal<typeof import('@happier-dev/iroh-native/node')>(),
  loadIrohNodeNative: () => ({ available: false, message: 'private-native-loader-detail' }),
}));

type NativeIrohModule = NonNullable<ReturnType<Parameters<typeof prepareDaemonMachineIrohRuntime>[0]['readRuntimeOptions']>['native']>;

describe('daemon native runtime startup decision', () => {
  it.each(['created', 'standard_only', 'startup_failed', 'native_unavailable'] as const)('records %s once without native details', async branch => {
    // Native endpoint creation/status is the OS boundary; startup policy and factory stay real.
    const native: Pick<NativeIrohModule, 'createEndpoint' | 'getEndpointStatus' | 'shutdownEndpoint'> = {
      createEndpoint: async () => {
        if (branch !== 'created') throw new Error('private-native-startup-detail');
        return { endpointHandle: 'endpoint', endpointId: 'a'.repeat(64), relayPolicy: 'disabled', relayMode: 'disabled',
          capProfile: 'machineBulk', relayUrls: [] };
      },
      getEndpointStatus: async () => ({ endpointHandle: 'endpoint', active: true, endpointId: 'a'.repeat(64), relayPolicy: 'disabled',
        relayMode: 'disabled', capProfile: 'machineBulk', relayUrls: [], directAddresses: [] }),
      shutdownEndpoint: async () => {},
    };
    const log = vi.spyOn(logger, 'infoFile');
    let runtime: Awaited<ReturnType<typeof prepareDaemonMachineIrohRuntime>> = null;
    try {
      runtime = await prepareDaemonMachineIrohRuntime({
        applicationCarrierEligibility: branch === 'standard_only' ? 'standard_only' : 'automatic',
        readRuntimeOptions: () => {
          if (branch === 'standard_only') throw new Error('Standard-only must not read native configuration');
          return { happyHomeDir: '/synthetic-home', identity: 'ephemeral',
            relayConfig: { relayPolicy: 'disabled', relayUrls: [] },
            // Only this partial native/OS boundary is consumed by the real factory.
            ...(branch === 'native_unavailable' ? {} : {
              native: native as NativeIrohModule,
            }) };
        } });
      expect(log.mock.calls.filter(([label]) => label === '[DAEMON RUN] Native Machine Iroh runtime decision')).toEqual([
        ['[DAEMON RUN] Native Machine Iroh runtime decision', { status: branch === 'created' ? 'created' : 'skipped',
          reason: branch === 'created' ? 'automatic' : branch }],
      ]);
      if (branch === 'standard_only') expect(runtime).toBeNull();
      else expect(runtime).toMatchObject({ available: branch === 'created' });
    } finally {
      await runtime?.shutdown();
      log.mockRestore();
    }
  });
});
