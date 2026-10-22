import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { PublicProfilePictureDescriptorV1Schema } from '@happier-dev/protocol/account/publicProfileAtmosphere';

import { renderScreen } from '@/dev/testkit';
import { preparePublicProfileAtmosphere } from '../preparePublicProfileAtmosphere';
import { PublicPictureBand } from './AtmospherePreview';

// The platform canvas (Skia/WebGL worker) is the boundary; the Brand paint inputs reaching it are not.
const painted: Array<Record<string, unknown>> = [];
vi.mock('../BackdropCanvas', () => ({
  BackdropCanvas: (props: Record<string, unknown>) => {
    painted.push(props);
    return null;
  },
}));

async function reviewedCopy() {
  const presentation = {
    ...DEFAULT_HOME_ATMOSPHERE,
    source: 'picture' as const,
    picture: {
      ref: { kind: 'user' as const, localId: 'own' },
      layout: 'horizon' as const,
    },
  };
  const store = {
    get: async () => ({
      localId: 'own',
      kind: 'user' as const,
      createdAtMs: 1,
      size: 3,
      data: 'data:image/png;base64,YWJj',
    }),
    prepare: async () => 'data:image/png;base64,YWJj',
  };
  const result = await preparePublicProfileAtmosphere({
    presentation,
    pictures: [],
    store,
    isCurrent: () => true,
  });
  if (result.status !== 'ready' || result.value.source !== 'picture')
    throw new Error('Expected a picture copy');
  const { descriptor } = result.value.picture;
  return PublicProfilePictureDescriptorV1Schema.parse({
    ...descriptor,
    look: { ...descriptor.look, effect: 'mosaic', strength: 0.37 },
  });
}

describe('PublicPictureBand', () => {
  it('paints a reviewed copy with its frozen effect, not as raw stored pixels', async () => {
    const descriptor = await reviewedCopy();
    painted.length = 0;
    const screen = await renderScreen(
      <PublicPictureBand
        picture={{ layout: 'horizon', descriptor }}
        data="data:image/png;base64,YWJj"
        copyId="pub-1"
      />,
    );
    await act(async () => {
      screen
        .findByTestId('public-picture-band')!
        .props.onLayout({
          nativeEvent: { layout: { width: 390, height: 300 } },
        });
    });
    const last = painted.at(-1);
    expect(last?.look).toBe('mosaic');
    expect(last?.size).toEqual({ width: 390, height: 300 });
    expect((last?.source as { data?: unknown } | undefined)?.data).toBe(
      'data:image/png;base64,YWJj',
    );
  });

  it('keeps the band empty until the copy’s bytes are read', async () => {
    const descriptor = await reviewedCopy();
    painted.length = 0;
    const screen = await renderScreen(
      <PublicPictureBand
        picture={{ layout: 'horizon', descriptor }}
        data={null}
        copyId="pub-1"
      />,
    );
    await act(async () => {
      screen
        .findByTestId('public-picture-band')!
        .props.onLayout({
          nativeEvent: { layout: { width: 390, height: 300 } },
        });
    });
    expect(painted).toHaveLength(0);
  });
});
