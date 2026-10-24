import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

const settings = vi.hoisted(() => ({ osFontScale: 1 }));
const initialLocalSettings = storage.getState().localSettings;

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
    Dimensions: { get: () => ({ width: 1024, height: 768, scale: 1, fontScale: settings.osFontScale }) },
  });
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

afterEach(() => {
  settings.osFontScale = 1;
  standardCleanup();
  storage.setState({ localSettings: initialLocalSettings });
});

const TWO_FACTS = {
  segments: ['Checkout UI retry states', '3 sessions waiting'],
};

async function renderLine(
  platform: 'web' | 'ios',
  fontScale: number,
  large: boolean,
) {
  // Both the header and Text must read the same real preference. Mocking only the legacy
  // hooks barrel gave the row 1.3 while Text's direct settings reader still observed 1.
  await act(async () => {
    storage.setState(state => ({ localSettings: { ...state.localSettings, uiFontScale: fontScale } }));
  });
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
  const result = {
    facts,
    firstFactStyle: flattenTestStyle(firstFact.props.style),
    allowFontScaling: firstFact.props.allowFontScaling,
    separator: String(secondFact.props.children[0] ?? ''),
  };
  await screen.unmount();
  return result;
}

describe('PaneHeaderLineView facts clip', { timeout: 240_000 }, () => {
  // The band keeps one line; a phone's large header has the whole width under its title, so facts that
  // run out of room wrap to a second line before any drops (lab FV6p), and only a third line is clipped.
  describe.each([
    ['band', false, 1, 'height'],
    ['large', true, 2, 'maxHeight'],
  ] as const)('%s facts row', (_name, large, lines, clip) => {
    it('clips to the lines the native Text renders at default, the largest in-app size and an OS font scale', async () => {
      let defaultLineHeight = 0;
      for (const [uiScale, osScale] of [[1, 1], [1.3, 1], [1, 1.5], [1.3, 1.5]] as const) {
        settings.osFontScale = osScale;
        const { facts, firstFactStyle, allowFontScaling } = await renderLine('ios', uiScale, large);
        if (uiScale === 1 && osScale === 1) defaultLineHeight = firstFactStyle.lineHeight as number;
        expect(firstFactStyle.lineHeight as number).toBeCloseTo(defaultLineHeight * uiScale, 5);
        expect(allowFontScaling).toBe(true);
        expect(facts).toMatchObject({ overflow: 'hidden', flexWrap: 'wrap' });
        // Native Text scales its own line height by the in-app size; the host scales it again by the OS size.
        expect(facts[clip] as number).toBeCloseTo((firstFactStyle.lineHeight as number) * osScale * lines, 5);
        if (large) expect(facts.height).toBeUndefined();
      }
    });

    it('scales the web clip by the in-app size alone, as the CSS variable scales the Text line height', async () => {
      const base = (await renderLine('web', 1, large)).facts[clip] as number;
      settings.osFontScale = 1.5;
      const largest = (await renderLine('web', 1.3, large)).facts;
      expect(largest).toMatchObject({ overflow: 'hidden', flexWrap: 'wrap' });
      expect(largest[clip] as number).toBeCloseTo(base * 1.3, 5);
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
