import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { SurfaceStateSizeProvider, useSurfaceStateCardSize } from '@/components/ui/surfaces/surfaceStateSize';
import { SessionViewerPicture } from './SessionViewerPicture';

function StateSizeProbe() {
  return React.createElement('StateSize', { size: useSurfaceStateCardSize() ?? 'unsized' });
}

async function stateSizeOf(framed: boolean, enclosing?: 'phone') {
  const picture = (
    <SessionViewerPicture framed={framed} source="browser">
      <StateSizeProbe />
    </SessionViewerPicture>
  );
  const screen = await renderScreen(
    enclosing ? <SurfaceStateSizeProvider size={enclosing}>{picture}</SurfaceStateSizeProvider> : picture,
  );
  try {
    return screen.root.findByType('StateSize').props.size;
  } finally {
    await screen.unmount();
  }
}

describe('SessionViewerPicture state size', () => {
  it('gives a framed viewer, whichever source it shows, the pane step even where the page is unsized', async () => {
    expect(await stateSizeOf(true)).toBe('pane');
  });

  it('leaves a pane on the step its container chose', async () => {
    expect(await stateSizeOf(false, 'phone')).toBe('phone');
  });
});
