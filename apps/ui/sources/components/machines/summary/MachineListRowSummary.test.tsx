import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// A passive row must not cross the encrypted/scoped transport boundary.
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport.rpc }));

const { storage } = await import('@/sync/domains/state/storageStore');
const { machineResourceStore } = await import('@/sync/domains/machines/resources/machineResourceStore');
const { MachineListRowSummary } = await import('./MachineListRowSummary');
const { describeMachineAttentionWord, readMachinePublishedResources, selectHeadlineReason } = await import('./machineResourceSentences');
const before = storage.getState();
afterEach(() => { standardCleanup(); machineResourceStore.reset(); storage.setState(before); transport.rpc.mockClear(); });

it('uses the row’s qualified Home for attention when another Home has the same machine id', async () => {
    const calm = { v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 },
        attention: { level: 'calm', reasons: [] } };
    const attention = { level: 'needs_you', reasons: [{ key: 'memory', level: 'needs_you', since: 1,
        metric: 'memory', kind: 'memory_pressure', pressure: 'critical', swapping: false }] };
    const active = createMachineFixture({ id: 'same-id', activeAt: Date.now(), daemonState: { resources: { ...calm, attention } } });
    const other = createMachineFixture({ id: 'same-id', activeAt: Date.now(), daemonState: { resources: calm } });
    storage.setState({ machines: { 'same-id': active }, machineListByServerId: { 'other-home': [other] },
        machineListStatusByServerId: { 'other-home': 'idle' },
        localSettings: { ...before.localSettings, uiMachineSummaryMetrics: [] } });
    const screen = await renderScreen(<MachineListRowSummary serverId="other-home" machineId="same-id" online quietWord="Online" />);
    expect(screen.getTextContent()).toBe('Online');
    const updated = { ...other, daemonStateVersion: 2, daemonState: { resources: { ...calm, attention } } };
    await act(async () => { storage.setState({ machines: { 'same-id': { ...active, daemonState: { resources: calm } } },
        machineListByServerId: { 'other-home': [updated] } }); });
    const reason = selectHeadlineReason(readMachinePublishedResources(updated.daemonState)!.attention)!;
    expect(screen.getTextContent()).toBe(describeMachineAttentionWord(reason));
    expect(transport.rpc).not.toHaveBeenCalled();
});

it('takes no width while an online machine has no vitals to show: no empty instruments beside the name', async () => {
    // Published as reporting, but no sample has arrived: the strip would draw only empty tracks.
    const calm = { v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 },
        attention: { level: 'calm', reasons: [] } };
    const machine = createMachineFixture({ id: 'quiet', activeAt: Date.now(), daemonState: { resources: calm } });
    storage.setState({ machines: { quiet: machine }, machineListByServerId: { 'home-a': [machine] },
        machineListStatusByServerId: { 'home-a': 'idle' },
        localSettings: { ...before.localSettings, uiMachineSummaryMetrics: ['cpu', 'memory', 'disk'] } });
    const screen = await renderScreen(<MachineListRowSummary testID="summary" serverId="home-a" machineId="quiet" online quietWord={null} />);
    expect(screen.findAll(node => typeof node.type === 'string' && node.props?.testID === 'summary')).toHaveLength(0);
});
