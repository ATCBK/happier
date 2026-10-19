import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicSessionModeProbeCacheForTests } from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
  ok: true as const,
  result: { availableModes: [{ id: 'plan', name: 'Plan' }] },
}));

const preflight = await installNewSessionPreflightHarness(machineCapabilitiesInvokeMock);
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
beforeEach(async () => {
  await preflight.reset();
  resetDynamicSessionModeProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('useNewSessionPreflightSessionModesState (cache)', () => {
  it('does not re-probe when a fresh result is cached', async () => {
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    let latest: ReturnType<typeof useNewSessionPreflightSessionModesState> | undefined;
    const readLatest = () => {
      if (!latest) throw new Error('Expected preflight modes to render');
      return latest;
    };
    function Harness() {
      latest = useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'backend', backendId: 'opencode' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
      });
      return null;
    }

    let root1!: renderer.ReactTestRenderer;
    root1 = (await renderScreen(React.createElement(Harness))).tree;
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(readLatest().preflightModes).not.toBeNull();
    });
    expect(readLatest().preflightModes?.availableModes.map(mode => mode.id)).toEqual(['plan']);
    await act(async () => {
      root1.unmount();
    });

    let root2!: renderer.ReactTestRenderer;
    root2 = (await renderScreen(React.createElement(Harness))).tree;
    expect(readLatest().preflightModes?.availableModes.map(mode => mode.id)).toEqual(['plan']);
    await act(async () => {
      root2.unmount();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
  });

    it('does not attempt dynamic session-mode probing for plugin backend targets', async () => {
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    function Harness() {
      useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root.unmount();
    });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(0);
    });

    it('keeps session-mode probing idle while the selected Agent Settings record loads', async () => {
        machineCapabilitiesInvokeMock.mockClear();
        resetDynamicSessionModeProbeCacheForTests();
        const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

        function Harness() {
            const result = useNewSessionPreflightSessionModesState({
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                runtimeCarrierAgentId: 'acme.review/provider',
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
                enabled: false,
            });
            expect(result.preflightModes).toBeNull();
            expect(result.probe.phase).toBe('idle');
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            root.unmount();
        });
        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(0);
    });
});
