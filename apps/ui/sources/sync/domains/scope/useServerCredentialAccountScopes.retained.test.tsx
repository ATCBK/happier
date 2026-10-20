import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { RetainedPanelSurface } = await import('@/components/ui/panels/RetainedPanelSurface');
const { useServerCredentialAccountScopeBinding } = await import('./useServerCredentialAccountScopes');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');

afterEach(() => standardCleanup());

it('keeps a hidden mounted credential binding current, then retires it on real unmount', async () => {
    const serverId = 'srv_retained_scope';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://retained-scope.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    let latest: ReturnType<typeof useServerCredentialAccountScopeBinding>['binding'] = null;
    function ScopeProbe() {
        const { binding } = useServerCredentialAccountScopeBinding(serverId);
        latest = binding;
        return React.createElement('ScopeProbe', { testID: 'scope-probe', current: binding?.isCurrent() === true });
    }
    const frame = (active: boolean) => <RetainedPanelSurface isActive={active} suspendWhenHidden><ScopeProbe /></RetainedPanelSurface>;
    const screen = await renderScreen(frame(true));
    await vi.waitFor(() => expect(screen.findByTestId('scope-probe')?.props.current).toBe(true));
    const binding = latest!;
    const retired = vi.fn();
    binding.onRetire(retired);
    await screen.update(frame(false));
    expect(binding.isCurrent()).toBe(true);
    expect(retired).not.toHaveBeenCalled();
    await screen.update(frame(true));
    expect(screen.findByTestId('scope-probe')?.props.current).toBe(true);
    expect(latest).toBe(binding);
    await screen.unmount();
    expect(binding.isCurrent()).toBe(false);
    expect(retired).toHaveBeenCalledOnce();
});

it('retires a replaced credential while hidden and reveals only the new Account binding', async () => {
    const serverId = 'srv_retained_scope_replacement';
    const serverUrl = 'https://retained-scope-replacement.example.test';
    const connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    let latest: ReturnType<typeof useServerCredentialAccountScopeBinding>['binding'] = null;
    function ScopeProbe() {
        const { binding } = useServerCredentialAccountScopeBinding(serverId);
        latest = binding;
        return React.createElement('ScopeProbe', { testID: 'scope-probe', accountId: binding?.isCurrent() ? binding.accountId : null });
    }
    const frame = (active: boolean) => <RetainedPanelSurface isActive={active} suspendWhenHidden><ScopeProbe /></RetainedPanelSurface>;
    const screen = await renderScreen(frame(true));
    await vi.waitFor(() => expect(latest?.isCurrent()).toBe(true));
    const original = latest!;
    const currentDuringRetirement: boolean[] = [];
    original.onRetire(() => { currentDuringRetirement.push(original.isCurrent()); });
    await screen.update(frame(false));
    await act(async () => {
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, {
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'replacement-account' })).toString('base64url')}.signature`,
        })).toBe(true);
    });
    expect(currentDuringRetirement).toEqual([false]);
    expect(original.isCurrent()).toBe(false);
    await screen.update(frame(true));
    expect(screen.findByTestId('scope-probe')?.props.accountId).toBe('replacement-account');
    expect(latest).not.toBe(original);
    await screen.unmount();
});
