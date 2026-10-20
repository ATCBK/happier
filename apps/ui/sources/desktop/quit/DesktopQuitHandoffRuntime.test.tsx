import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * Boundaries only: the native host bridge (the exit handoff arrives as an event and is finished by
 * commands), the system-task bridge (hsetup), the modal and text catalogues. The status parser,
 * shared status, saved Homes, session visibility and the quit decision run for real.
 */
const host = vi.hoisted(() => ({
    listeners: new Map<string, (payload: unknown) => void>(),
    invocations: [] as Array<{ command: string; args?: Record<string, unknown> }>,
}));
vi.mock('@/utils/platform/desktopHost', async () => {
    const actual = await vi.importActual<typeof import('@/utils/platform/desktopHost')>('@/utils/platform/desktopHost');
    return {
        ...actual,
        isDesktopHost: () => true,
        invokeDesktopHost: async (command: string, args?: Record<string, unknown>) => {
            host.invocations.push(args ? { command, args } : { command });
            return null;
        },
        listenDesktopHostEvent: async (event: string, handler: (payload: unknown) => void) => {
            host.listeners.set(event, handler);
            return () => host.listeners.delete(event);
        },
    };
});

const modal = vi.hoisted(() => ({ answer: 'keep' as 'keep' | 'stop', asked: [] as string[] }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alertAsync: async (title, _message, buttons) => {
                modal.asked.push(title);
                const wanted = modal.answer === 'stop' ? 'destructive' : 'cancel';
                buttons?.find((button) => button.style === wanted)?.onPress?.();
            },
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

type Start = { kind: string; params: Record<string, unknown> };
const tasks = vi.hoisted(() => ({ starts: [] as Start[], runner: null as unknown, failStop: false, nextId: 0, statusData: {} as Record<string, unknown> }));
vi.mock('@/components/systemTasks/systemTasksRuntime', () => ({ getSystemTasksRunner: () => tasks.runner }));

import { publishLocalDaemonStatus } from '@/components/settings/machines/localControl/localDaemonSharedState';
import { readLocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { getStorage } from '@/sync/domains/state/storageStore';

import { DesktopQuitHandoffRuntime } from './DesktopQuitHandoffRuntime';

const setupListeners = new Map<string, { onResult: (payload: unknown) => void }>();

/** A fresh runner per test: its shared status and task ids start empty. */
function freshRunner(): SystemTaskRunner {
    const kinds = new Map<string, string>();
    return createSystemTaskRunner({
        bridge: {
            async start(spec) {
                tasks.starts.push(spec as Start);
                tasks.nextId += 1;
                const taskId = `task_${tasks.nextId}`;
                kinds.set(taskId, spec.kind);
                return taskId;
            },
            async subscribe(taskId, listenerSet) {
                const kind = kinds.get(taskId);
                // A setup run stays in flight until the test ends it.
                if (kind?.startsWith('setup.')) {
                    setupListeners.set(taskId, listenerSet);
                    return () => {};
                }
                const fails = tasks.failStop && kind === 'daemon.service.stop.v1';
                // A status read answers with this computer's current status (the app-open start re-reads it).
                const data = kind === 'daemon.service.status.v1' ? tasks.statusData : {};
                queueMicrotask(() => listenerSet.onResult(fails
                    ? { protocolVersion: 1, taskId, ok: false, error: { code: 'daemon_service_stop_failed', message: 'work.example.test kept running.' } }
                    : { protocolVersion: 1, taskId, ok: true, data: data as never }));
                return () => {};
            },
            async cancel() {},
            async respond() {},
        },
    });
}

const row = (relayUrl: string, extra: Record<string, unknown> = {}) => ({
    relayUrl,
    state: 'connected',
    appManaged: true,
    serviceTargetMode: 'pinned',
    actions: ['restart', 'stop'],
    ...extra,
});

function publishStatus(data: Record<string, unknown>) {
    tasks.statusData = data;
    const status = readLocalDaemonStatusData({ protocolVersion: 1, taskId: 'status', ok: true, data } as never);
    if (status) publishLocalDaemonStatus(tasks.runner as SystemTaskRunner, status);
}

/** The app is on the Home whose daemon reports this account, with its session list loaded. */
function seeSessionsOfThisComputer() {
    getStorage().setState({ isDataReady: true, profile: { ...profileDefaults, id: 'acct_app' }, sessions: {} });
}

const stops = () => tasks.starts.filter((start) => start.kind === 'daemon.service.stop.v1');

async function quit(payload: unknown) {
    const screen = await renderScreen(<DesktopQuitHandoffRuntime />);
    await act(async () => {
        host.listeners.get('desktop_app_exit_requested')?.(payload);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.invocations.some((call) => call.command === 'desktop_finish_shutdown')).toBe(true));
    await act(async () => screen.tree.unmount());
}

const baseStatus = {
    serviceInstalled: true,
    daemonRunning: true,
    needsAuth: false,
    machineId: 'machine_here',
    daemonServerUrl: 'https://home.example.test',
    daemonAccountId: 'acct_app',
    serviceRowsComplete: true,
    runningManagedServiceCount: 1,
};
const initialStorage = getStorage().getState();

describe('DesktopQuitHandoffRuntime (R16 a)', () => {
    beforeEach(async () => {
        await seedPersistedHomeProfilesForTests({ activeServerId: 'home', profiles: [
            { id: 'home', name: 'home', serverUrl: 'https://home.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
        ] });
        tasks.runner = freshRunner();
    });

    afterEach(() => {
        host.listeners.clear();
        host.invocations.length = 0;
        tasks.starts.length = 0;
        modal.asked.length = 0;
        modal.answer = 'keep';
        tasks.failStop = false;
        tasks.statusData = {};
        getStorage().setState(initialStorage, true);
    });

    it('starts the on-demand services once the app open proved that mode, through the one aggregate start (A13-03, R13C-F2)', async () => {
        publishStatus({ ...baseStatus, serviceAutostart: 'on-demand', serviceRows: [row('https://home.example.test', { state: 'offline', actions: ['start'] })] });
        const screen = await renderScreen(<DesktopQuitHandoffRuntime />);
        await vi.waitFor(() => expect(tasks.starts.some((start) => start.kind === 'daemon.service.start.v1')).toBe(true));
        const starts = tasks.starts.filter((entry) => entry.kind === 'daemon.service.start.v1');
        expect(starts).toHaveLength(1);
        expect(starts[0]!.params).toMatchObject({ onDemandOnly: true });
        expect(starts[0]!.params).not.toHaveProperty('relayUrl');
        await act(async () => screen.tree.unmount());
    });

    it('starts nothing as the app opens while the mode is unproven or the services start at login', async () => {
        const screen = await renderScreen(<DesktopQuitHandoffRuntime />);
        await act(async () => {
            publishStatus({ ...baseStatus, serviceAutostart: null, serviceRows: [row('https://home.example.test')] });
        });
        await act(async () => {
            publishStatus({ ...baseStatus, serviceAutostart: 'at-login', serviceRows: [row('https://home.example.test')] });
        });
        expect(tasks.starts.filter((entry) => entry.kind === 'daemon.service.start.v1')).toEqual([]);
        await act(async () => screen.tree.unmount());
    });

    it('keeps the tray and every service when the managed services start at login (A13-02)', async () => {
        publishStatus({ ...baseStatus, serviceAutostart: 'at-login', serviceRows: [row('https://home.example.test')] });
        await quit({ stopServices: false });
        expect(stops()).toEqual([]);
        expect(host.invocations.at(-1)).toEqual({ command: 'desktop_finish_shutdown', args: { outcome: 'menuBar' } });
    });

    it.each(['on-demand', 'at-login'])('keeps resolved unknown authoritative over persisted %s mode (A15-02)', async (persistedMode) => {
        publishStatus({ ...baseStatus, serviceAutostart: null, serviceRows: [row('https://home.example.test')] });
        seeSessionsOfThisComputer();
        await quit({ serviceAutostart: persistedMode });
        expect(stops()).toEqual([]);
        expect(modal.asked).toEqual([]);
        expect(host.invocations.at(-1)).toEqual({ command: 'desktop_finish_shutdown' });
    });

    it('stops without asking when every running managed service is the app\'s own and no session runs there', async () => {
        seeSessionsOfThisComputer();
        publishStatus({ ...baseStatus, serviceAutostart: 'on-demand', serviceRows: [row('https://home.example.test'), row('https://work.example.test', { state: 'offline', actions: ['start'] })] });
        await quit({ stopServices: false });
        expect(modal.asked).toEqual([]);
        expect(stops()).toHaveLength(1);
        expect(stops()[0]?.params).not.toHaveProperty('relayUrl');
        expect(host.invocations.at(-1)).toEqual({ command: 'desktop_finish_shutdown' });
    });

    it('asks when another Home\'s managed service is running, since its sessions are invisible here (A13-01)', async () => {
        seeSessionsOfThisComputer();
        publishStatus({ ...baseStatus, serviceAutostart: 'at-login', runningManagedServiceCount: 2, serviceRows: [row('https://home.example.test'), row('https://work.example.test')] });
        modal.answer = 'stop';
        await quit({ stopServices: true });
        expect(modal.asked).toEqual(['settingsDesktop.tray.quitStopUnknownTitle']);
        expect(stops()).toHaveLength(1);
    });

    it('asks when more managed services run than the app can see, even on its own Home (a default and a pin, A13-01)', async () => {
        seeSessionsOfThisComputer();
        publishStatus({ ...baseStatus, serviceAutostart: 'on-demand', runningManagedServiceCount: 2, serviceRows: [row('https://home.example.test')] });
        await quit({ stopServices: false });
        expect(modal.asked).toEqual(['settingsDesktop.tray.quitStopUnknownTitle']);
    });

    it('treats an incomplete inventory as unknown and asks (A13-01)', async () => {
        seeSessionsOfThisComputer();
        publishStatus({ ...baseStatus, serviceAutostart: 'on-demand', serviceRowsComplete: false, serviceRows: [row('https://home.example.test')] });
        await quit({ stopServices: false });
        expect(modal.asked).toEqual(['settingsDesktop.tray.quitStopUnknownTitle']);
        // Kept on purpose: nothing stops, and on-demand services have no menu bar to stay in.
        expect(stops()).toEqual([]);
        expect(host.invocations.at(-1)).toEqual({ command: 'desktop_finish_shutdown' });
    });

    it('keeps the tray when the person keeps services that start at login (C8 a)', async () => {
        publishStatus({ ...baseStatus, serviceAutostart: 'at-login', serviceRows: [row('https://home.example.test')] });
        await quit({ stopServices: true });
        expect(stops()).toEqual([]);
        expect(host.invocations.at(-1)).toEqual({ command: 'desktop_finish_shutdown', args: { outcome: 'menuBar' } });
    });

    it('never swallows a stop that failed: it says what kept running and stays in the menu bar (C8 b)', async () => {
        modal.answer = 'stop';
        tasks.failStop = true;
        publishStatus({ ...baseStatus, serviceAutostart: 'on-demand', serviceRows: [row('https://home.example.test')] });
        await quit({ stopServices: false });
        expect(stops()).toHaveLength(1);
        expect(modal.asked.at(-1)).toBe('settingsDesktop.tray.quitStopFailedTitle');
        expect(host.invocations.at(-1)).toEqual({ command: 'desktop_finish_shutdown', args: { outcome: 'menuBar' } });
    });

    it('decides from the mode the native side last persisted when this app open has not read one yet (C8 c)', async () => {
        await quit({ stopServices: false, serviceAutostart: 'at-login' });
        expect(stops()).toEqual([]);
        expect(host.invocations.at(-1)).toEqual({ command: 'desktop_finish_shutdown', args: { outcome: 'menuBar' } });
    });

    it('exits instead of staying in a menu bar the host does not have', async () => {
        publishStatus({ ...baseStatus, serviceAutostart: 'at-login', serviceRows: [row('https://home.example.test')] });
        await quit({ stopServices: false, menuBarSupported: false });
        expect(stops()).toEqual([]);
        expect(host.invocations.at(-1)).toEqual({ command: 'desktop_finish_shutdown' });
    });

    it('keeps the window when a stop failed, even on a host without a menu bar (N-9)', async () => {
        modal.answer = 'stop';
        tasks.failStop = true;
        publishStatus({ ...baseStatus, serviceAutostart: 'on-demand', serviceRows: [row('https://home.example.test')] });
        await quit({ stopServices: false, menuBarSupported: false });
        expect(modal.asked.at(-1)).toBe('settingsDesktop.tray.quitStopFailedTitle');
        expect(host.invocations.at(-1)).toEqual({ command: 'desktop_finish_shutdown', args: { outcome: 'menuBar' } });
    });

    it('stops without asking when nothing managed runs, even if the app sees no daemon (N-15)', async () => {
        // Not signed in, so no session list: nothing managed runs, so a stop ends no session either.
        publishStatus({ ...baseStatus, daemonRunning: false, serviceAutostart: 'on-demand', runningManagedServiceCount: 0, serviceRows: [row('https://home.example.test', { state: 'offline', actions: ['start'] })] });
        await quit({ stopServices: false });
        expect(modal.asked).toEqual([]);
        expect(stops()).toHaveLength(1);
    });

    it('waits for a setup run in flight, then starts the services that run left stopped (N-14, A14-05)', async () => {
        const runner = tasks.runner as SystemTaskRunner;
        // A setup run the app started and that is still going.
        const setupTaskId = await runner.start({ protocolVersion: 1, kind: 'setup.thisComputer.v1', params: { surface: 'desktop.ui', target: 'thisComputer', channel: 'stable' } } as never);
        publishStatus({
            ...baseStatus,
            serviceAutostart: 'on-demand',
            serviceRows: [row('https://home.example.test'), row('https://work.example.test', { state: 'offline', actions: ['start'] })],
        });
        const screen = await renderScreen(<DesktopQuitHandoffRuntime />);
        await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
        expect(tasks.starts.filter((entry) => entry.kind === 'daemon.service.start.v1')).toEqual([]);

        // The setup run ends: the app-open start was not spent on it.
        await act(async () => {
            setupListeners.get(setupTaskId)?.onResult({ protocolVersion: 1, taskId: setupTaskId, ok: true, data: {} });
        });
        await vi.waitFor(() => expect(tasks.starts.filter((entry) => entry.kind === 'daemon.service.start.v1')).toHaveLength(1));
        await act(async () => screen.tree.unmount());
    });

});
