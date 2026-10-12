import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';

import { ProjectOverviewLayout, resolveProjectOverviewArrangement } from './ProjectOverviewLayout';

afterEach(standardCleanup);

function RetainedBody(props: Readonly<{ id: string }>) {
  const [value, setValue] = React.useState('loading');
  return React.createElement(Pressable, { testID: props.id, onPress: () => setValue(`${props.id}:last-known`) }, React.createElement(Text, null, value));
}

it('keeps the admitted main and aside bodies when the measured desktop arrangement changes', async () => {
  const aside = React.createElement(RetainedBody, { id: 'aside-body' });
  const screen = await renderScreen(React.createElement(ProjectOverviewLayout, {
    bar: null, main: React.createElement(RetainedBody, { id: 'main-body' }), aside,
  }));
  await screen.pressByTestIdAsync('main-body');
  await screen.pressByTestIdAsync('aside-body');
  for (const width of [791, 944, 583, 791]) {
    await act(async () => {
      screen.findByTestId('project-overview')!.props.onLayout({ nativeEvent: { layout: { width } } });
    });
    expect(screen.findByTestId('main-body')!.findByType(Text).props.children).toBe('main-body:last-known');
    expect(screen.findByTestId('aside-body')!.findByType(Text).props.children).toBe('aside-body:last-known');
  }
});

describe('resolveProjectOverviewArrangement', () => {
  it('keeps both areas side by side while the measured page holds the main minimum beside the aside', () => {
    expect(resolveProjectOverviewArrangement(944)).toBe('columns');
    expect(resolveProjectOverviewArrangement(792)).toBe('columns');
  });

  it('puts the aside first once the page can no longer hold both (D32 FIT), and holds before measuring', () => {
    // Still two aside widths wide: the side area pairs its widgets rather than stretching them thin.
    expect(resolveProjectOverviewArrangement(791)).toBe('pairs');
    expect(resolveProjectOverviewArrangement(584)).toBe('pairs');
    expect(resolveProjectOverviewArrangement(583)).toBe('stacked');
    expect(resolveProjectOverviewArrangement(null)).toBe('columns');
  });
});
