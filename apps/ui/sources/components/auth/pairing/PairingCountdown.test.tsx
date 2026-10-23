import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PairingCountdown } from './PairingCountdown';

const host = vi.hoisted(() => ({ emitter: null as ReturnType<typeof import('@/dev/testkit/mocks/reactNative').createReactNativeAppStateEmitter> | null }));
vi.mock('react-native', async () => {
    const kit = await import('@/dev/testkit/mocks/reactNative');
    host.emitter = kit.createReactNativeAppStateEmitter();
    return kit.createReactNativeWebMock({ AppState: host.emitter.appState });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }));
afterEach(async () => { await act(async () => { host.emitter?.emit('active'); }); vi.useRealTimers(); });

it('ticks only while its code is visible and live, and catches up immediately on return', async () => {
    const expiresAtMs = Date.now() + 120_000;
    const element = (presented: boolean) => <PluginSurfaceFocusEligibilityProvider active={presented}>
        <PairingCountdown testID="expiry" expiresAtMs={expiresAtMs} />
    </PluginSurfaceFocusEligibilityProvider>;
    const screen = await renderScreen(element(true));
    expect(vi.getTimerCount()).toBe(1);
    await screen.update(element(false));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await screen.update(element(true));
    expect(screen.getTextContent()).toContain('1:00');
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { host.emitter!.emit('background'); });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(60_000); host.emitter!.emit('active'); });
    expect(screen.getTextContent()).toContain('0:00');
    expect(vi.getTimerCount()).toBe(0);
    await screen.unmount();
});
