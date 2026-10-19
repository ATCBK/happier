import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkspaceSyncHarness } from '@/dev/testkit/harness/workspaceSyncHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const requests: AbortSignal[] = [];
let pending = true;
const harness = createWorkspaceSyncHarness(async request => {
    if (request.method !== RPC_METHODS.DAEMON_WORKSPACE_SYNC_LEGACY_INSPECT) throw new Error(`Unexpected RPC ${request.method}`);
    requests.push(request.signal);
    if (pending) await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort',
        () => reject(new Error('aborted')), { once: true }));
    return { status: 'absent' };
});
await harness.ready;
const { WorkspaceSyncLegacyStateRecovery } = await import('./WorkspaceSyncLegacyStateRecovery');
afterEach(async () => { standardCleanup(); await harness.dispose(); requests.length = 0; pending = true; });

it('cancels unanswered legacy inspections on unmount and can inspect again on return', async () => {
    await harness.reset();
    const screen = await renderScreen(<WorkspaceSyncLegacyStateRecovery />);
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    await screen.unmount();
    expect(requests.every(signal => signal.aborted)).toBe(true);
    pending = false;
    const next = await renderScreen(<WorkspaceSyncLegacyStateRecovery />);
    await vi.waitFor(() => expect(next.findByTestId('workspace-sync-legacy-reinspect')).toBeNull());
    await next.unmount();
});
