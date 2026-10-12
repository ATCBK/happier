import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('admits an overdue resettle only when the desktop window becomes visible', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  let visibility = 'hidden';
  const listeners = new Set<() => void>();
  // The desktop bridge and document are host boundaries; visibility policy stays real.
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: () => undefined });
  vi.stubGlobal('document', {
    get visibilityState() { return visibility; },
    hasFocus: () => false,
    addEventListener: (event: string, listener: () => void) => {
      if (event === 'visibilitychange') listeners.add(listener);
    },
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  });
  const { storage } = await import('@/sync/domains/state/storageStore');
  const { pictureStore } = await import('./pictureStore');
  const { HomeIdleResettle } = await import('./HomeIdleResettle');
  const previous = storage.getState();
  const picture = ATMOSPHERE_PICTURES[0];
  const ensure = vi.spyOn(pictureStore, 'ensureBuiltin').mockImplementation(() => new Promise(() => {}));
  storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
    ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: {
      ...DEFAULT_HOME_ATMOSPHERE.picture, ref: { kind: 'builtin', id: picture.id },
    },
  } } }));
  const screen = await renderScreen(<HomeIdleResettle picture={picture.id} focused writing={false} sending={false} />);
  try {
    await act(async () => { vi.advanceTimersByTime(3_600_000); });
    expect(ensure).not.toHaveBeenCalled();
    await act(async () => {
      visibility = 'visible';
      listeners.forEach(listener => listener());
    });
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(ensure).toHaveBeenCalledTimes(1);
  } finally {
    await screen.unmount();
    await act(async () => { storage.setState(previous, true); });
  }
});
