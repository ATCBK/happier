import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMemoryDecisionHomeFixture } from '@/dev/testkit/harness/memoryDecisionHomeFixture';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDisconnectedServerSocketBoundary();

const viewport = vi.hoisted(() => ({ width: 1440 }));
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' }, {
    useWindowDimensions: () => ({ width: viewport.width, height: 900, scale: 1, fontScale: 1 }),
  });
});
// Safe-area measurements come from the device SDK; the overlay policy stays real.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 34, left: 0 }),
  initialWindowMetrics: null,
}));

const { SaveMemoryDecisionSheet, seedMemoryDecisionFromMessage } = await import('./SaveMemoryDecisionSheet');
afterEach(() => { standardCleanup(); viewport.width = 1440; });

async function open() {
  const f = await createMemoryDecisionHomeFixture();
  const source: CoordinationMessageRefV1 = { kind: 'discussion',
    discussion: { serverId: f.serverId, discussionId: 'discussion-1' }, messageId: 'committed-source' };
  const screen = await renderScreen(<SaveMemoryDecisionSheet seed={seedMemoryDecisionFromMessage(source, 'Keep the cap at 5')}
    anchorRef={{ current: null }} onClose={() => {}} onSaved={() => {}} />);
  return { f, screen };
}

describe('Save as decision presentation', () => {
  it('is the shared phone sheet on a phone-width window, with the form carrying its own header', async () => {
    viewport.width = 390;
    const { f, screen } = await open();
    try {
      const dialog = screen.findAll(node => node.props.role === 'dialog')[0];
      expect(dialog?.props.accessibilityLabel).toBeTruthy();
      expect(screen.findByTestId('save-memory-decision')).toBeTruthy();
    } finally { await screen.unmount(); await f.home.dispose(); }
  });

  it('stays the anchored panel on a wide window', async () => {
    const { f, screen } = await open();
    try {
      expect(screen.findAll(node => node.props.role === 'dialog')).toHaveLength(0);
      expect(screen.findByTestId('save-memory-decision')).toBeTruthy();
    } finally { await screen.unmount(); await f.home.dispose(); }
  });
});
