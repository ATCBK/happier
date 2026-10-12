import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
afterEach(() => { standardCleanup(); });

const SCOPE = { serverId: 'home-1', accountId: 'account-1' };

it('carries a widget’s mark and state line, not its title alone, as Session cards do (lab wgdnd 1, F4 D-18)', async () => {
    const { useSessionSurfaceEntityDrag } = await import('./SessionSurfaceEntityDrag');
    const renderMark = (size: number) => <>{`mark:${size}`}</>;
    const drag = (await renderHook(() => useSessionSurfaceEntityDrag({
        scope: SCOPE, isCurrent: () => true, title: 'Period summary', subtitle: 'Account · Medium', renderMark,
        getItem: () => ({ kind: 'home-section', scope: SCOPE, sectionId: 'period' }),
    }))).getCurrent();
    expect(drag.runtime.describeSource(drag.sourceId)).toEqual({ title: 'Period summary', subtitle: 'Account · Medium', renderMark });
});
