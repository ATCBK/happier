import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ThemePreferenceTransitionHost } from './ThemePreferenceTransitionHost.native';
import { runThemePreferenceChange } from './themePreferenceTransition';

// Native view-shot is the OS screenshot boundary.
vi.mock('react-native-view-shot', () => ({ captureRef: async () => 'file://theme-before.png', releaseCapture: vi.fn() }));
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock({ settleTimingCallbacks: true }));
afterEach(() => { vi.useRealTimers(); });

it('keeps the native pre-auth wipe and chooses Horizon only after sign-in, without remounting the host', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const credentials = { token: 'test-token', secret: 'test-secret' };
    const element = (signedIn: boolean) => <InjectedAuthProvider credentials={signedIn ? credentials : null}>
        <ThemePreferenceTransitionHost><>{'app-content'}</></ThemePreferenceTransitionHost>
    </InjectedAuthProvider>;
    const screen = await renderScreen(element(false), { createNodeMock: () => ({}) });
    const change = () => runThemePreferenceChange({ currentPreference: 'light', nextPreference: 'dark',
        platform: 'ios', reduceMotion: false, systemTheme: 'light', mutation() {} });
    const pending = change();
    await flushHookEffects();
    expect(screen.findAllByType('Canvas')).toHaveLength(0);
    expect(screen.findAll(node => node.props.source?.uri === 'file://theme-before.png').length).toBeGreaterThan(0);
    await act(async () => { vi.advanceTimersByTime(32); });
    await pending;
    await screen.update(element(true));
    const authenticated = change();
    await flushHookEffects();
    expect(screen.findAllByType('Canvas')).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(32); });
    await screen.unmount();
    await authenticated;
});
