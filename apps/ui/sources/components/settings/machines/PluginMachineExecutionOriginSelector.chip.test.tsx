import * as React from 'react';
import { act } from 'react-test-renderer';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, withPopoverWebGlobals } from '@/dev/testkit';
import { composePluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import type { PluginMachineExecutionOriginCandidateV1, PluginMachineSourceExecutionOriginCandidateV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import type { PluginMachineExecutionOriginSelectionV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import { installNewSessionComponentsCommonModuleMocks } from '../../sessions/new/components/newSessionComponentsTestHelpers';

installNewSessionComponentsCommonModuleMocks({
    storage: (importOriginal) => importOriginal(),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

installDisconnectedServerSocketBoundary();
const { PluginMachineExecutionOriginSelectorView } = await import('./PluginMachineExecutionOriginSelector');
const { storage } = await import('@/sync/domains/state/storageStore');
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await account?.dispose();
    account = null;
});

async function installLiveMachine() {
    account = await restoreServerAccountForTest({ serverUrl: 'https://picker-presence.test', serverIdentityId: 'srv_picker_one' });
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', activeAt: Date.now(), updatedAt: Date.now() })], true,
        { sourceServerId: account.home.id });
}

const unlistedSource: PluginMachineSourceExecutionOriginCandidateV1 = {
    source: { origin: { serverIdentityId: 'srv_picker_one', sourceRef: { machineId: 'unknown-machine', pluginId: 'acme.plugin',
        sourceCustody: { kind: 'development', registeredRootId: 'source-a' } } }, version: '1.0.0', occurrenceId: 'occurrence-a', serverId: 'srv_picker_one', generation: 1 },
    releaseContent: 'matched', validation: { kind: 'admitted' },
};

function createSelection(machineIds: readonly [string, string] = ['machine-a', 'machine-b']) {
    const candidates: readonly PluginMachineExecutionOriginCandidateV1[] = [
        {
            materialization: {
                serverIdentityId: 'srv_picker_one', machineId: machineIds[0], materializationId: 'installation-a',
                pluginId: 'acme.plugin', version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true,
                uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 100,
            },
            releaseContent: 'matched', validation: { kind: 'admitted' },
        },
        {
            materialization: {
                serverIdentityId: 'srv_picker_one', machineId: machineIds[1], materializationId: 'installation-b',
                pluginId: 'acme.plugin', version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true,
                uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 100,
            },
            releaseContent: 'matched', validation: { kind: 'rejected', reason: 'offline' },
        },
    ];
    const selectOrigin = vi.fn(async () => ({ status: 'applied' as const, settingsVersion: 8, value: undefined }));
    const selection: PluginMachineExecutionOriginSelectionV1 = {
        candidates,
        state: { kind: 'selectionRequired', candidates },
        selectedOrigin: null,
        canExecute: false,
        selectOrigin,
        clearOrigin: async () => ({ status: 'applied', settingsVersion: 8, value: undefined }),
        resolveExecutionOrigin: () => null,
    };
    return { selection, candidates, selectOrigin };
}

describe('PluginMachineExecutionOriginSelector header chip', () => {
    it('shows real Online presence despite an old unchanged plugin observation', () => withPopoverWebGlobals(async () => {
        await installLiveMachine();
        const fixture = createSelection();
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={{ ...fixture.selection, candidates: [fixture.candidates[0]!] }}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        expect(screen.getTextContent()).toContain('settingsOverview.machineOnline');
        expect(screen.getTextContent()).not.toContain('settingsOverview.machineOffline');
        expect(screen.getTextContent()).toContain('common.version 1.0.0');
    }));

    it('keeps plugin rejection separate from live Machine presence', () => withPopoverWebGlobals(async () => {
        await installLiveMachine();
        const fixture = createSelection();
        const rejected = { ...fixture.candidates[0]!, validation: { kind: 'rejected' as const, reason: 'disabled' as const } };
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={{ ...fixture.selection, candidates: [rejected] }}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        const row = screen.findHostByTestId('plugin.execution.picker-option:machine-a');
        const text = screen.getTextContent();
        expect(text).toContain('settingsOverview.machineOnline');
        expect(text).toContain('settingsPlugins.machineMatrix.state.disabled');
        expect(text).not.toContain('settingsOverview.machineOffline');
        expect(row?.props.disabled ?? row?.props.accessibilityState?.disabled ?? row?.props['aria-disabled']).toBe(true);
    }));

    it('does not invent last-seen or a presence dot for a source without a Machine record', () => withPopoverWebGlobals(async () => {
        await installLiveMachine();
        const fixture = createSelection();
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={{ ...fixture.selection, candidates: [unlistedSource] }}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        const text = screen.getTextContent();
        expect(text).not.toContain('settingsOverview.machineOffline');
        expect(text).not.toContain('settingsOverview.machineOnline');
        expect(screen.findHostByTestId('plugin.execution.picker-option:unknown-machine')).not.toBeNull();
        expect(screen.findHostByTestId('plugin.execution.picker-readiness:unknown-machine')).toBeNull();
    }));

    it('retains a stale plugin reason when no Machine presence line can explain it', () => withPopoverWebGlobals(async () => {
        await installLiveMachine();
        const fixture = createSelection();
        const rejected = { ...unlistedSource, validation: { kind: 'rejected' as const, reason: 'stale' as const } };
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={{ ...fixture.selection, candidates: [rejected] }}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        expect(screen.findHostByTestId('plugin.execution.picker-option:unknown-machine')).not.toBeNull();
        expect(screen.getTextContent()).toContain('settingsPlugins.machineMatrix.state.staleOffline');
        expect(screen.getTextContent()).not.toContain('settingsOverview.machineOffline');
    }));

    it('does not borrow a same-id Machine from another Home', () => withPopoverWebGlobals(async () => {
        await installLiveMachine();
        const fixture = createSelection();
        const otherHome = { ...fixture.candidates[0]!, materialization: {
            ...fixture.candidates[0]!.materialization, serverIdentityId: 'srv_picker_other',
        } };
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={{ ...fixture.selection, candidates: [otherHome] }}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        expect(screen.findHostByTestId('plugin.execution.picker-option:machine-a')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('settingsOverview.machineOnline');
        expect(screen.getTextContent()).not.toContain('settingsOverview.machineOffline');
        expect(screen.findHostByTestId('plugin.execution.picker-readiness:machine-a')).toBeNull();
    }));

    it('re-reads a retained heartbeat at the canonical deadline and ages only the Machine presence', () => withPopoverWebGlobals(async () => {
        await installLiveMachine();
        vi.useFakeTimers();
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS', '1000');
        const fixture = createSelection();
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={{ ...fixture.selection, candidates: [fixture.candidates[0]!] }}
            presentation="chip" testIDPrefix="plugin.execution" />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        expect(screen.getTextContent()).toContain('settingsOverview.machineOnline');
        await act(async () => { await vi.advanceTimersByTimeAsync(800); });
        await act(async () => {
            storage.getState().applyMachines([{ ...storage.getState().machines['machine-a']!, activeAt: Date.now() }], false,
                { sourceServerId: account!.home.id });
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(201); });
        expect(screen.getTextContent()).toContain('settingsOverview.machineOnline');
        expect(screen.getTextContent()).not.toContain('settingsOverview.machineOffline');
        await act(async () => { await vi.advanceTimersByTimeAsync(800); });
        expect(screen.getTextContent()).toContain('settingsOverview.machineOffline');
        await act(async () => {
            storage.getState().applyMachines([{ ...storage.getState().machines['machine-a']!, activeAt: Date.now() }], false,
                { sourceServerId: account!.home.id });
        });
        expect(screen.getTextContent()).toContain('settingsOverview.machineOnline');
        expect(screen.getTextContent()).not.toContain('settingsOverview.machineOffline');
        expect(fixture.candidates[0]!.materialization.observedAt).toBe(100);
        await screen.unmount();
    }));

    it('opens the shared machine list and submits the exact installation while rejecting offline choices', () => withPopoverWebGlobals(async () => {
        const fixture = createSelection();
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView
            selection={fixture.selection}
            presentation="chip"
            testIDPrefix="plugin.execution"
        />);
        expect(screen.findHostByTestId('plugin.execution.chip')).not.toBeNull();
        expect(screen.findHostByTestId('plugin.execution.picker-list')).toBeNull();
        await screen.pressByTestIdAsync('plugin.execution.chip');
        expect(screen.findHostByTestId('plugin.execution.picker-list')).not.toBeNull();
        const offline = screen.findHostByTestId('plugin.execution.picker-option:machine-b');
        expect(offline?.props.disabled ?? offline?.props.accessibilityState?.disabled ?? offline?.props['aria-disabled']).toBe(true);
        await screen.pressByTestIdAsync('plugin.execution.picker-option:machine-a');
        expect(fixture.selectOrigin).toHaveBeenCalledWith(composePluginMachineExecutionOriginV1(fixture.candidates[0]!.materialization));
        const chip = screen.findHostByTestId('plugin.execution.chip');
        expect(chip?.props.accessibilityState?.expanded ?? chip?.props['aria-expanded']).toBe(false);
    }));

    it('tells same-named machines apart by a short suffix, never by the opaque machine id', () => withPopoverWebGlobals(async () => {
        const ids = ['3f9a2c10-7b1e-4d55-9a02-c1d5e8f01234', '8be4d1a7-52c3-4c0e-b6f9-0a41d7c9e555'] as const;
        const fixture = createSelection(ids);
        const machineCandidates = ids.map((machineId) => ({
            target: { serverIdentityId: 'srv_picker_one', machineId },
            displayName: 'Build box', serverLabel: 'Home', availability: 'online' as const, observation: 'live' as const, observedAt: 100,
        }));
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView
            selection={fixture.selection}
            machineCandidates={machineCandidates}
            presentation="chip"
            testIDPrefix="plugin.execution"
        />);
        await screen.pressByTestIdAsync('plugin.execution.chip');
        const text = screen.getTextContent();
        expect(text).toContain('Build box · 3f9a');
        expect(text).toContain('Build box · 8be4');
        for (const id of ids) expect(text).not.toContain(id);
    }));
});
