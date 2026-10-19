import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import * as React from 'react';
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS } from '@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capabilityRpc = vi.fn();
const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const probeCache = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
beforeEach(async () => {
    await preflight.reset();
    probeCache.resetDynamicConfigOptionsProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('useNewSessionPreflightConfigOptionsState', () => {
    it('keeps previous config options visible while a new cwd probe is pending', async () => {

        const capabilityRpc = vi.fn()
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: {
                        configOptions: [{ id: 'opt1', name: 'Option 1', type: 'boolean', currentValue: true }],
                    },
                }))
            .mockImplementationOnce(async () => new Promise<never>(() => undefined));
        preflight.setCapabilityResponder(capabilityRpc);
        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let cwd = '/repo';
        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null = null;
        const readLatest = () => {
            const value = latest as ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null;
            if (!value) throw new Error('Expected preflight config options state to render');
            return value;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd,
            } as any);
            return null;
        }

        const screen = await renderScreen(React.createElement(Harness));
        const root = screen.tree;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readLatest().configOptions).not.toBeNull();
        });
        expect((readLatest().configOptions ?? []).map((option) => option.id)).toEqual(['opt1']);

        cwd = '/repo-2';
        await screen.update(React.createElement(Harness));

        const refreshed = readLatest();
        expect(refreshed.probe.phase).toBe('refreshing');
        expect((refreshed.configOptions ?? []).map((option) => option.id)).toEqual(['opt1']);

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(2);
        });
        await act(async () => {
            root.unmount();
        });
    });

    it('probes config options for non-Codex providers (provider-agnostic)', async () => {

        const capabilityRpc = vi.fn(async (_machineId: string, _request: unknown) => ({ ok: true as const, result: { configOptions: [] } }));
        preflight.setCapabilityResponder(capabilityRpc);

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        function Harness() {
            useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'opencode' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
        });
        await act(async () => {
            root.unmount();
        });

        expect(capabilityRpc).toHaveBeenCalledTimes(1);
        const firstCall = capabilityRpc.mock.calls[0] as unknown as [unknown, unknown] | undefined;
        expect(firstCall?.[1]).toMatchObject({
            id: 'cli.opencode',
            method: 'probeConfigOptions',
            params: expect.objectContaining({ timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS, cwd: '/repo' }),
        });
    });

    it('forwards probeContext.capabilityParams to probeConfigOptions', async () => {

        const capabilityRpc = vi.fn(async (_machineId: string, _request: unknown) => ({ ok: true as const, result: { configOptions: [] } }));
        preflight.setCapabilityResponder(capabilityRpc);

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        const probeContext = {
            cacheKeySuffixParts: ['appServer'],
            capabilityParams: { profileId: 'profile-a' },
        };

        function Harness() {
            useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
                probeContext,
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
        });
        await act(async () => {
            root.unmount();
        });

        expect(capabilityRpc).toHaveBeenCalledTimes(1);
        const firstCall = capabilityRpc.mock.calls[0] as unknown as [unknown, unknown] | undefined;
        expect(firstCall?.[1]).toMatchObject({
            id: 'cli.codex',
            method: 'probeConfigOptions',
            params: expect.objectContaining({ profileId: 'profile-a' }),
        });
    });

    it('treats empty dynamic config options as a successful empty probe result', async () => {

        const capabilityRpc = vi.fn(async (_machineId: string, _request: unknown) => ({ ok: true as const, result: { configOptions: [], source: 'dynamic' } }));
        preflight.setCapabilityResponder(capabilityRpc);

        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null = null;
        const readLatest = () => {
            const value = latest as ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null;
            if (!value) throw new Error('Expected preflight config options state to render');
            return value;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo-dynamic-empty',
            } as any);
            return null;
        }

        const root = (await renderScreen(React.createElement(Harness))).tree;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readLatest().probe.refreshedAt).toEqual(expect.any(Number));
        });

        expect(capabilityRpc).toHaveBeenCalledTimes(1);
        expect(readLatest().configOptions).toEqual([]);
        expect(readLatest().unavailable).toBe(false);
        expect(readLatest().probe.refreshedAt).toEqual(expect.any(Number));

        await act(async () => {
            root.unmount();
        });
    });

    it('carries typed unavailable state when config option discovery is unavailable', async () => {

        const capabilityRpc = vi.fn(async (_machineId: string, _request: unknown) => ({ ok: true as const, result: { configOptions: [], source: 'unavailable' } }));
        preflight.setCapabilityResponder(capabilityRpc);

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null = null;
        const readLatest = () => {
            const value = latest as ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null;
            if (!value) throw new Error('Expected preflight config options state to render');
            return value;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readLatest().unavailable).toBe(true);
        });
        await act(async () => {
            root.unmount();
        });

        expect(readLatest().configOptions).toEqual([]);
        expect(readLatest().unavailable).toBe(true);
    });

    it('keeps config option discovery unavailable fail-closed across a same-scope remount during cooldown', async () => {

        const capabilityRpc = vi.fn(async (_machineId: string, _request: unknown) => ({ ok: true as const, result: { configOptions: [], source: 'unavailable' } }));
        preflight.setCapabilityResponder(capabilityRpc);

        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null = null;
        const readLatest = () => {
            const value = latest as ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null;
            if (!value) throw new Error('Expected preflight config options state to render');
            return value;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo-unavailable-remount',
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readLatest().unavailable).toBe(true);
        });
        await act(async () => {
            root.unmount();
        });

        latest = null;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            root.unmount();
        });

        expect(capabilityRpc).toHaveBeenCalledTimes(1);
        expect(readLatest().configOptions).toEqual([]);
        expect(readLatest().unavailable).toBe(true);
    });

    it('retries after an unavailable cooldown elapses so temporarily gated config options can recover', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);

        const capabilityRpc = vi.fn()
            .mockImplementationOnce(async () => ({ ok: true as const, result: { configOptions: [], source: 'unavailable' } }))
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: {
                        configOptions: [{
                            id: 'sandbox',
                            name: 'Sandbox',
                            type: 'boolean',
                            currentValue: true,
                        }],
                    },
                }));
        preflight.setCapabilityResponder(capabilityRpc);

        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null = null;
        const readLatest = () => {
            const value = latest as ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null;
            if (!value) throw new Error('Expected preflight config options state to render');
            return value;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo-unavailable-retry',
            } as any);
            return null;
        }

        const root = (await renderScreen(React.createElement(Harness))).tree;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readLatest().unavailable).toBe(true);
        });

        expect(capabilityRpc).toHaveBeenCalledTimes(1);
        expect(readLatest().configOptions).toEqual([]);
        expect(readLatest().unavailable).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS + 1);
        });

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(2);
            expect(readLatest().unavailable).toBe(false);
        });
        expect((readLatest().configOptions ?? []).map((option) => option.id)).toEqual(['sandbox']);
        expect(readLatest().unavailable).toBe(false);

        await act(async () => {
            root.unmount();
        });
        vi.useRealTimers();
    });

    it('replaces previous successful config options when a forced refresh reports unavailable', async () => {

        const capabilityRpc = vi.fn()
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: {
                        configOptions: [{
                            id: 'sandbox',
                            name: 'Sandbox',
                            type: 'boolean',
                            currentValue: true,
                        }],
                    },
                }))
            .mockImplementationOnce(async () => ({ ok: true as const, result: { configOptions: [], source: 'unavailable' } }));
        preflight.setCapabilityResponder(capabilityRpc);

        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null = null;
        const readLatest = () => {
            const value = latest as ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null;
            if (!value) throw new Error('Expected preflight config options state to render');
            return value;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo-success-to-unavailable',
            } as any);
            return null;
        }

        const root = (await renderScreen(React.createElement(Harness))).tree;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readLatest().configOptions).not.toBeNull();
        });
        expect((readLatest().configOptions ?? []).map((option) => option.id)).toEqual(['sandbox']);
        expect(readLatest().unavailable).toBe(false);

        await act(async () => {
            readLatest().probe.onRefresh?.();
        });

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readLatest().unavailable).toBe(true);
        });
        expect(capabilityRpc).toHaveBeenCalledTimes(2);
        expect(readLatest().configOptions).toEqual([]);
        expect(readLatest().unavailable).toBe(true);

        await act(async () => {
            root.unmount();
        });
    });

    it('does not re-probe when probeContext identity changes but content is stable', async () => {

        // Intentionally never resolves to avoid setState loops influencing the test outcome.
        const pending = new Promise<never>(() => undefined);
        const capabilityRpc = vi.fn(async (_machineId: string, _request: unknown) => pending as never);
        preflight.setCapabilityResponder(capabilityRpc);

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        function Harness() {
            const [_tick, setTick] = React.useState(0);
            React.useEffect(() => {
                setTick(1);
            }, []);

            useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
                // Inline object creation simulates callers that don't memoize probeContext.
                probeContext: {
                    cacheKeySuffixParts: ['appServer'],
                    capabilityParams: { profileId: 'profile-a' },
                },
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
        });
        await act(async () => {
            root.unmount();
        });

        expect(capabilityRpc).toHaveBeenCalledTimes(1);
    });
    it('probes config options for an installed Agent that carries no bundled catalog id', async () => {
        // An installed Session Agent is a first-class runtime carrier: its
        // operational Agent id is the probe identity, exactly as the models
        // probe already treats it. Narrowing the probe identity to the closed
        // bundled set is what silently removes ACP configuration options from
        // every installed Agent.

        const capabilityRpc = vi.fn(async (_machineId: string, _request: unknown) => ({ ok: true as const, result: { configOptions: [] } }));
        preflight.setCapabilityResponder(capabilityRpc);

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        function Harness() {
            useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'acme.review' },
                runtimeCarrierAgentId: 'acme.review',
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
        });
        await act(async () => {
            root.unmount();
        });

        expect(capabilityRpc).toHaveBeenCalledTimes(1);
        const firstCall = capabilityRpc.mock.calls[0] as unknown as [unknown, unknown] | undefined;
        expect(firstCall?.[1]).toMatchObject({
            id: 'cli.acme.review',
            method: 'probeConfigOptions',
        });
    });
});
