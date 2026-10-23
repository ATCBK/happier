import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createIrohNodeNativeModule, loadIrohNodeNative, loadIrohNodeNativeAddon } from './nodeNative';
import { IROH_NODE_NATIVE_EXPORTS, type IrohNodeNativeAddon } from './nodeNative.types';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Requirement: the binding surface is lifecycle/status only. These tests
 * enumerate the exported surface (typed module always; raw addon when built)
 * and fail if any byte/payload/generic-dispatch API appears.
 */
function createNullAddon(): IrohNodeNativeAddon {
  const nullEnvelope = async () => JSON.stringify({ ok: true, result: null });
  return {
    getAvailability: () => ({
      available: true,
      os: 'test-os',
      arch: 'test-arch',
      engine: 'happier-iroh-native',
      surface: [...IROH_NODE_NATIVE_EXPORTS],
    }),
    createEndpoint: nullEnvelope,
    startHomeAcceptor: nullEnvelope,
    stopHomeAcceptor: nullEnvelope,
    ensureHomeTunnel: nullEnvelope,
    releaseHomeTunnel: nullEnvelope,
    shutdownEndpoint: nullEnvelope,
    getEndpointStatus: nullEnvelope,
    getTunnelStatus: nullEnvelope,
    startMachineAcceptor: nullEnvelope,
    stopMachineAcceptor: nullEnvelope,
    getMachineAcceptorStatus: nullEnvelope,
    startMachineTunnel: nullEnvelope,
    startMachineHttpTunnel: nullEnvelope,
    stopMachineTunnel: nullEnvelope,
    getMachineTunnelStatus: nullEnvelope,
    waitMachineTunnelClosed: nullEnvelope,
  };
}

describe('no-payload crossing of the Node/Bun lifecycle binding', () => {
  it('exports exactly the lifecycle allowlist on the typed module', () => {
    const module = createIrohNodeNativeModule(createNullAddon());
    expect(Object.keys(module).sort()).toEqual([...IROH_NODE_NATIVE_EXPORTS].sort());
    for (const name of IROH_NODE_NATIVE_EXPORTS) {
      expect(typeof module[name]).toBe('function');
    }
  });

  it('binding sources contain no byte, typed-array, or stream-callback API', () => {
    const sources = [
      join(packageRoot, 'rust', 'happier-iroh-node', 'src', 'lib.rs'),
      join(packageRoot, 'src', 'nodeNative.ts'),
      join(packageRoot, 'src', 'nodeNative.types.ts'),
    ];
    const forbidden = ['Buffer', 'Uint8Array', 'ArrayBuffer', 'TypedArray', 'DataView', 'onTunnelBytes'];
    for (const source of sources) {
      const text = readFileSync(source, 'utf8');
      for (const identifier of forbidden) {
        expect(text, `${source} must not reference ${identifier}`).not.toMatch(
          new RegExp(`\\b${identifier}\\b`),
        );
      }
    }
  });

  const loaded = loadIrohNodeNative();
  const itWhenNative = loaded.available ? it : it.skip;

  itWhenNative('raw addon exports only lifecycle and allocator maintenance operations', () => {
    if (!loaded.available || loaded.addonPath === null) {
      throw new Error('native addon unexpectedly unavailable');
    }
    const addon = loadIrohNodeNativeAddon(loaded.addonPath);
    expect(Object.keys(addon).sort()).toEqual([...IROH_NODE_NATIVE_EXPORTS, 'trimProcessAllocator'].sort());
  });
});
