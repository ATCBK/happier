import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

const settings = vi.hoisted(() => ({ fontScale: 1, osFontScale: 1 }));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    useWindowDimensions: () => ({
      width: 1024,
      height: 768,
      scale: 1,
      fontScale: settings.osFontScale,
    }),
  });
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

// The in-app text size is device-local storage, outside the text owner.
vi.mock('@/sync/store/hooks', () => ({
  useLocalSetting: () => settings.fontScale,
}));

afterEach(() => {
  settings.fontScale = 1;
  settings.osFontScale = 1;
  standardCleanup();
  vi.resetModules();
});

const TWO_FACTS = {
  segments: ['Checkout UI retry states', '3 sessions waiting'],
};

async function renderLine(
  platform: 'web' | 'ios',
  fontScale: number,
  large: boolean,
) {
  settings.fontScale = fontScale;
  const { Platform } = await import('react-native');
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: platform,
  });
  const { PaneHeaderLineView } = await import('./PaneHeader');
  const screen = await renderScreen(
    <PaneHeaderLineView line={TWO_FACTS} large={large} testID="header" />,
  );
  const facts = flattenTestStyle(
    screen.findByTestId('header.subtitle')!.props.style,
  );
  const firstFact = screen.findAllByType('Text' as never)[0]!;
  const secondFact = screen.findAllByType('Text' as never)[1]!;
  return {
    facts,
    firstFactStyle: flattenTestStyle(firstFact.props.style),
    separator: String(secondFact.props.children[0] ?? ''),
  };
}

describe('PaneHeaderLineView one-line clip', { timeout: 240_000 }, () => {
  describe.each([
    ['band', false],
    ['large', true],
  ] as const)('%s facts row', (_name, large) => {
    it('clips to the same line the native Text renders at default, the largest in-app size and an OS font scale', async () => {
      for (const [uiScale, osScale] of [[1, 1], [1.3, 1], [1, 1.5]] as const) {
        settings.osFontScale = osScale;
        const { facts, firstFactStyle } = await renderLine('ios', uiScale, large);
        expect(facts).toMatchObject({ overflow: 'hidden', flexWrap: 'wrap' });
        // Native Text scales its own line height by the in-app size; the host scales it again by the OS size.
        expect(facts.height as number).toBeCloseTo((firstFactStyle.lineHeight as number) * osScale, 5);
      }
    });

    it('scales the web clip by the in-app size alone, as the CSS variable scales the Text line height', async () => {
      const base = (await renderLine('web', 1, large)).facts.height as number;
      settings.osFontScale = 1.5;
      const largest = (await renderLine('web', 1.3, large)).facts;
      expect(largest).toMatchObject({ overflow: 'hidden', flexWrap: 'wrap' });
      expect(largest.height as number).toBeCloseTo(base * 1.3, 5);
    });
  });

  it('keeps every fact inside one clipped row, so a second fact that does not fit wraps below it and drops whole', async () => {
    const { facts } = await renderLine('ios', 1.3, false);
    expect(facts).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', overflow: 'hidden' });
  });

  it('separates facts with a space web cannot collapse at the start of a flex item', async () => {
    const { separator } = await renderLine('web', 1, false);
    expect(separator).toMatch(/^\u00A0·\u00A0/);
  });
});
