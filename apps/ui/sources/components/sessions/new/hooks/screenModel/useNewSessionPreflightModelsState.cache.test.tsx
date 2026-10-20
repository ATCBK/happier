import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi, afterAll, afterEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const probeResultState = {
  value: { availableModels: [{ id: 'm1', name: 'Model 1' }], supportsFreeform: false } as {
    availableModels: Array<{ id: string; name: string }>;
    supportsFreeform: boolean;
  },
};

const capabilityRpc = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
    ok: true as const,
    result: probeResultState.value,
  }));

type ProbeResponse = Awaited<ReturnType<typeof capabilityRpc>>;

const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
const probeCache = await import('@/sync/domains/models/dynamicModelProbeCache');
beforeEach(async () => {
    await preflight.reset();
    probeCache.resetDynamicModelProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('useNewSessionPreflightModelsState (cache)', () => {
  beforeEach(() => {
    probeResultState.value = {
      availableModels: [{ id: 'm1', name: 'Model 1' }],
      supportsFreeform: false,
    };
  });

  it('does not re-probe when a fresh result is cached', async () => {

    capabilityRpc.mockClear();
    resetDynamicModelProbeCacheForTests();

    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    let latest: ReturnType<typeof useNewSessionPreflightModelsState> | undefined;
    const readLatest = () => {
      if (!latest) throw new Error('Expected preflight models to render');
      return latest;
    };
    function Harness() {
      latest = useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
      });
      return null;
    }

    let root1!: renderer.ReactTestRenderer;
    root1 = (await renderScreen(React.createElement(Harness))).tree;
    await vi.waitFor(() => expect(readLatest().preflightModels?.availableModels.map(model => model.id)).toEqual(['m1']));
    await act(async () => {
      root1.unmount();
    });

    let root2!: renderer.ReactTestRenderer;
    root2 = (await renderScreen(React.createElement(Harness))).tree;
    expect(readLatest().preflightModels?.availableModels.map(model => model.id)).toEqual(['m1']);
    await act(async () => {
      root2.unmount();
    });

    expect(capabilityRpc).toHaveBeenCalledTimes(1);
  });

  it('does not attempt dynamic model probing for plugin backend targets', async () => {

    capabilityRpc.mockClear();
    resetDynamicModelProbeCacheForTests();

    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    function Harness() {
      useNewSessionPreflightModelsState({
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

    expect(capabilityRpc).toHaveBeenCalledTimes(0);
  });

  it('keeps the model probe idle while the selected Agent Settings record loads', async () => {

    capabilityRpc.mockClear();
    resetDynamicModelProbeCacheForTests();

    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    function Harness() {
      const result = useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
        runtimeCarrierAgentId: 'acme.review/provider',
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
        enabled: false,
      });
      expect(result.preflightModels).toBeNull();
      expect(result.probe.phase).toBe('idle');
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root.unmount();
    });

    expect(capabilityRpc).toHaveBeenCalledTimes(0);
  });

  it('keeps a freeform-only probe result when the backend supports custom model ids without listing models', async () => {

    capabilityRpc.mockClear();
    resetDynamicModelProbeCacheForTests();
    probeResultState.value = {
      availableModels: [],
      supportsFreeform: true,
    };

    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    let latestPreflightModels: Readonly<{
      availableModels: ReadonlyArray<Readonly<{ id: string; name: string; description?: string }>>;
      supportsFreeform: boolean;
    }> | null = null;

    function Harness() {
      latestPreflightModels = useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
      }).preflightModels;
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;

    await vi.waitFor(() => {
      expect(capabilityRpc).toHaveBeenCalledTimes(1);
      expect(latestPreflightModels).toEqual({
        availableModels: [],
        supportsFreeform: true,
      });
    });

    await act(async () => {
      root.unmount();
    });
  });

  it('resets the probe phase to idle when switching to a backend with static model selection', async () => {

    resetDynamicModelProbeCacheForTests();

    let resolveProbe: ((value: ProbeResponse) => void) | undefined;
    capabilityRpc.mockImplementationOnce(() => new Promise((resolve) => {
      resolveProbe = resolve;
    }));

    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    let latestProbePhase: 'idle' | 'loading' | 'refreshing' = 'idle';

    function Harness(props: { agentId: 'codex' | 'gemini' }) {
      latestProbePhase = useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: props.agentId },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
      }).probe.phase;
      return null;
    }

    const screen = await renderScreen(React.createElement(Harness, { agentId: 'codex' }));
    const root = screen.tree;

    expect(latestProbePhase).toBe('loading');
    await vi.waitFor(() => expect(resolveProbe).toBeTypeOf('function'));

    await screen.update(React.createElement(Harness, { agentId: 'gemini' }));

    expect(latestProbePhase).toBe('idle');

    if (!resolveProbe) {
      throw new Error('expected deferred probe resolver');
    }

    resolveProbe({
        ok: true,
        result: {
          availableModels: [{ id: 'm1', name: 'Model 1' }],
          supportsFreeform: false,
        },
      });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      root.unmount();
    });
  });
});
