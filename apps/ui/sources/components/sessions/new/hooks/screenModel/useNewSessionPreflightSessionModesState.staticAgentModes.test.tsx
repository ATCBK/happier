import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
  ok: true as const, result: { availableModes: [{ id: 'plan', name: 'Plan' }] },
}));

vi.mock('@/text', async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translateLoose: (key: string) => `t:${key}`,
        });
});

const preflight = await installNewSessionPreflightHarness(machineCapabilitiesInvokeMock);
beforeEach(() => preflight.reset());
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('useNewSessionPreflightSessionModesState (staticAgentModes)', () => {
  it('returns static mode options without probing capabilities', async () => {
    machineCapabilitiesInvokeMock.mockClear();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    let latest: any = null;
    function Harness() {
      latest = useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'backend', backendId: 'claude' },
        selectedMachineId: null,
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(0);
    expect(latest.probe.phase).toBe('idle');
    expect(latest.probe.onRefresh).toBeUndefined();
    expect((latest.modeOptions ?? []).map((o: any) => o.id)).toEqual(['default', 'plan']);
    expect((latest.modeOptions ?? [])[0]?.name).toBe('t:agentInput.mode.build');

    await act(async () => {
      root.unmount();
    });
  });
});
