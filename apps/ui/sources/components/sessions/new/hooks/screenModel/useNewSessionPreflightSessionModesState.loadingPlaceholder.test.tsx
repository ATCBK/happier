import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import * as React from 'react';
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicSessionModeProbeCacheForTests } from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';
import { flushHookEffects, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let resolveProbe: null | (() => void) = null;
const capabilityRpc = vi.fn(async (_machineId: any, _request: any, _options: any) => {
  await new Promise<void>((resolve) => {
    resolveProbe = resolve;
  });
  return {
      ok: true as const,
      result: { availableModes: [{ id: 'plan', name: 'Plan' }] },
    };
});

const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const probeCache = await import('@/sync/domains/sessionModes/dynamicSessionModeProbeCache');
beforeEach(async () => {
    await preflight.reset();
    probeCache.resetDynamicSessionModeProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('useNewSessionPreflightSessionModesState (loading placeholder)', () => {
  it('returns a default option while probing so the UI can show a loading state', async () => {

    resolveProbe = null;
    capabilityRpc.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    let latest: any = null;
    function Harness() {
      latest = useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'backend', backendId: 'opencode' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;

    expect(latest.probe.phase).toBe('loading');
    expect((latest.modeOptions ?? []).map((o: any) => o.id)).toEqual(['default']);

    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(capabilityRpc).toHaveBeenCalledTimes(1);
      expect(resolveProbe).not.toBeNull();
    });
    await act(async () => {
      resolveProbe?.();
    });
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(latest.preflightModes).not.toBeNull();
    });

    expect((latest.modeOptions ?? []).some((o: any) => o.id === 'plan')).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});
