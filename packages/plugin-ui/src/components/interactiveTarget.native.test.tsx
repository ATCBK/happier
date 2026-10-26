import * as React from 'react';
import { resolveHappierTypeScale } from '../presentation/text/typeScale.js';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativePlatform = vi.hoisted(() => ({
  OS: 'ios',
  select: <T,>(options: Readonly<{ ios?: T; android?: T; native?: T; default?: T }>) => (
    options.ios ?? options.android ?? options.native ?? options.default
  ),
}));

// React Native is the platform boundary. The public adapters and shared
// presentation path remain real so the assertions observe the native frames
// that receive the provider's platform fact.
vi.mock('react-native', () => ({
  Platform: nativePlatform,
  // The public barrel loads motion constants; these text/target tests never animate a preview.
  Easing: { bezier: () => (progress: number) => progress },
  I18nManager: { isRTL: false },
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  // The public barrel also loads the shared cursor's native stylesheet.
  StyleSheet: {
    hairlineWidth: 1,
    absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
    create: <T extends Record<string, unknown>>(styles: T) => styles,
    flatten: flattenStyle,
  },
  // A Toggle is the platform switch on native (the shared HappierSwitchNative).
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));

import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';
import { HappierUiPlatformProvider } from '../environment/index.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import {
  Button,
  Form,
  IconButton,
  Link,
  List,
  Menu,
  Surface,
  Tabs,
  Text,
} from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle));
  }
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function resolvePressableStyle(style: unknown): Record<string, unknown> {
  return flattenStyle(typeof style === 'function'
    ? style({
        pressed: false,
        hovered: false,
        focused: false,
        selected: false,
        busy: false,
        disabled: false,
      })
    : style);
}

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
});

async function renderInteractiveFamilies(
  platform: 'android' | 'ios' | 'desktop' | 'web',
  outerPlatform?: 'android' | 'ios' | 'desktop' | 'web',
  textScale = 1,
) {
  const context = createSurfaceContext({ platform, textScale });
  const presentationHost = {
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderPopover: (input: Parameters<PluginUiPresentationHost['renderPopover']>[0]) => input.content({
      requestClose: () => input.onRequestClose(),
      maxHeight: 240,
    }),
    renderIcon: () => null,
  };

  const surface = (
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={presentationHost}>
          <Button testID="button" title="Run" onPress={() => undefined} />
          <IconButton testID="icon-button" accessibilityLabel="Refresh" icon={<Text value="R" />} onPress={() => undefined} />
          <Surface testID="surface" accessibilityLabel="Open details" onPress={() => undefined}>
            <Text testID="scaled-text" value="Details" variant="meta" />
          </Surface>
          <List.Item testID="list-tight:first" title="First" density="tight" onPress={() => undefined} />
          <List.Item testID="list-tight:second" title="Second" density="tight" onPress={() => undefined} />
          <Form.TextField testID="text-field" label="Name" value="" onChange={() => undefined} />
          <Form.Toggle testID="toggle" label="Enabled" value={false} onChange={() => undefined} />
          <Form.Select
            testID="select"
            label="Mode"
            options={[{ value: 'safe', label: 'Safe', testID: 'select-option' }]}
            value="safe"
            onChange={() => undefined}
          />
          <Tabs testID="tabs" value="summary" onValueChange={() => undefined} ariaLabel="Sections">
            <Tabs.Item value="summary" title="Summary"><Text value="Summary" /></Tabs.Item>
          </Tabs>
          <Link testID="link" title="Documentation" url="https://docs.happier.dev" />
          <Menu
            testID="menu-trigger"
            open
            onOpenChange={() => undefined}
            trigger="More"
            triggerAccessibilityLabel="More actions"
            items={[
              { id: 'first', label: 'First action' },
              { id: 'second', label: 'Second action' },
            ]}
            onSelect={() => undefined}
          />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>
  );

  await act(async () => {
    renderer = create(
      outerPlatform === undefined ? surface : (
        <HappierUiPlatformProvider platform={{ platform: outerPlatform, colorScheme: 'light' }}>
          {surface}
        </HappierUiPlatformProvider>
      ),
    );
  });
}

function findPressable(testID: string) {
  const target = renderer!.root.findAll((node) => (
    (node.type === 'Pressable' || node.type === 'Switch') && node.props.testID === testID
  ));
  expect(target, `missing native interactive host ${testID}`).toHaveLength(1);
  return target[0]!;
}

function layOut(node: { props: Record<string, unknown> }, width: number, height: number) {
  const onLayout = node.props.onLayout as ((event: unknown) => void) | undefined;
  expect(onLayout, 'a control under a finger measures its drawn box').toBeTypeOf('function');
  act(() => {
    onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width, height } } });
  });
}

/** Re-read a host node after a state update replaced it. */
function findHost(type: string, testID: string) {
  const hosts = renderer!.root.findAll((node) => node.type === type && node.props.testID === testID);
  expect(hosts, `missing ${type} ${testID}`).toHaveLength(1);
  return hosts[0]!;
}

describe('public interactive families use the provider-owned native target policy', () => {
  for (const [platform, minimum] of [
    ['android', 48],
    ['ios', 44],
  ] as const) {
    it(`keeps ${platform} controls at their drawn size and reaches the touch target as hit area`, async () => {
      await renderInteractiveFamilies(platform);

      // Interaction-core families: the drawing keeps its design size and the hit area reaches the
      // target past it, never a physical floor.
      for (const testID of ['button', 'icon-button', 'surface', 'tabs:summary', 'link', 'menu-trigger']) {
        const target = findPressable(testID);
        const style = resolvePressableStyle(target.props.style);
        expect(style.minWidth ?? 0, `${testID} must not be floored wide`).toBeLessThan(minimum);
        // A page button is drawn at the page control height on every platform, Android included.
        expect(style.minHeight ?? 0, `${testID} must not be floored tall`)
          .toBeLessThanOrEqual(testID === 'button' ? HAPPIER_PAGE_METRICS.controlHeightPx : minimum - 1);
        // DOM-only semantics must not leak into the native view config.
        expect(target.props.role).toBeUndefined();
        expect(target.props.onKeyDown).toBeUndefined();
        expect(target.props.accessibilityRole).toBeTypeOf('string');

        layOut(target, 28, 20);
        const slop = findHost('Pressable', testID).props.hitSlop as Record<string, number>;
        const reach = (minimum - 20) / 2;
        // A tab's strip clips above and below it; every other control reaches the full target.
        expect(slop.top, testID).toBe(testID.startsWith('tabs:') ? 0 : reach);
        expect(slop.bottom, testID).toBe(testID.startsWith('tabs:') ? 0 : reach);
        expect(slop.left + 28 + slop.right, testID).toBeGreaterThanOrEqual(testID.startsWith('tabs:') ? 28 : minimum);
      }

      // The platform switch keeps the platform's own size; a press beside it reaches it.
      const toggle = findPressable('toggle');
      expect(resolvePressableStyle(toggle.props.style).minWidth).toBeUndefined();
      expect(resolvePressableStyle(toggle.props.style).minHeight).toBeUndefined();
      layOut(toggle, 51, 31);
      const toggleHit = renderer!.root.findAll((node) => (
        node.type === 'Pressable' && node.props.accessible === false && node.props.hitSlop !== undefined
      ));
      expect(toggleHit).toHaveLength(1);
      expect(toggleHit[0]!.props.hitSlop.top).toBe((minimum - 31) / 2);

      // A tight list row keeps its density height on a finger too. Its reach between stacked rows
      // belongs to the List owner (TT-SHARED-B), not to this family check.
      for (const testID of ['list-tight:first', 'list-tight:second']) {
        expect(resolvePressableStyle(findPressable(testID).props.style).minHeight).toBe(36);
      }
      // A select option takes the shared hit area (its group owner bounds the reach between options).
      layOut(findPressable('select-option'), 60, 20);
      const optionReach = findHost('Pressable', 'select-option').props.hitSlop.top as number;
      expect(optionReach).toBeGreaterThan(0);
      expect(optionReach).toBeLessThanOrEqual((minimum - 20) / 2);

      const textField = renderer!.root.findAll((node) => (
        node.type === 'TextInput' && node.props.testID === 'text-field'
      ));
      expect(textField, 'missing native text input').toHaveLength(1);

      const menuRows = renderer!.root.findAll((node) => (
        node.type === 'Pressable' && node.props.accessibilityRole === 'menuitem'
      ));
      expect(menuRows).toHaveLength(2);
      for (const row of menuRows) {
        // Adjacent rows inside a clipping menu: each row is its own hit area.
        expect(row.props.hitSlop).toBeUndefined();
      }
    });
  }

  for (const platform of ['desktop', 'web'] as const) {
    it(`retains compact ${platform} list density`, async () => {
      await renderInteractiveFamilies(platform);

      const row = findPressable('list-tight:first');
      expect(resolvePressableStyle(row.props.style).minHeight).toBe(36);
    });
  }

  it('lets a nested plugin surface shadow the host root platform fact', async () => {
    await renderInteractiveFamilies('desktop', 'android');

    const row = findPressable('list-tight:first');
    expect(resolvePressableStyle(row.props.style).minHeight).toBe(36);
  });

  it('applies the projected native text scale exactly once to Text and TextInput', async () => {
    const context = createSurfaceContext({ platform: 'ios', textScale: 2 });
    await renderInteractiveFamilies('ios', undefined, 2);

    const text = renderer!.root.findAll((node) => (
      node.type === 'Text' && node.props.testID === 'scaled-text'
    ));
    expect(text).toHaveLength(1);
    expect(text[0]!.props.allowFontScaling).toBe(false);
    expect(flattenStyle(text[0]!.props.style)).toMatchObject({
      fontSize: resolveHappierTypeScale('meta', 'ios').fontSize * 2,
      lineHeight: resolveHappierTypeScale('meta', 'ios').lineHeight * 2,
    });

    const textInput = renderer!.root.findAll((node) => (
      node.type === 'TextInput' && node.props.testID === 'text-field'
    ));
    expect(textInput).toHaveLength(1);
    expect(textInput[0]!.props.allowFontScaling).toBe(false);
    expect(flattenStyle(textInput[0]!.props.style)).toMatchObject({
      fontSize: resolveHappierTypeScale('meta', 'ios').fontSize * 2,
      lineHeight: resolveHappierTypeScale('meta', 'ios').lineHeight * 2,
    });
  });

  it('gives invalid field controls native issue hints and a polite live announcement', async () => {
    const context = createSurfaceContext({ platform: 'ios' });
    await act(async () => {
      renderer = create(
        <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
          <Form.Field label="Access token" issue="Enter a valid access token.">
            <Form.TextField testID="invalid-token" label="Access token" value="" onChange={() => undefined} />
          </Form.Field>
          <Form.Field label="Mode" issue="Choose a connection mode.">
            <Form.Select
              label="Mode"
              options={[{ value: 'safe', label: 'Safe', testID: 'invalid-mode-option' }]}
              value="safe"
              onChange={() => undefined}
            />
          </Form.Field>
          <Form.Field label="Enabled" issue="Confirm whether the provider is enabled.">
            <Form.Toggle testID="invalid-toggle" label="Enabled" value={false} onChange={() => undefined} />
          </Form.Field>
        </PluginUiProvider>,
      );
    });

    const textInput = renderer!.root.findAll((node) => (
      node.type === 'TextInput' && node.props.testID === 'invalid-token'
    ));
    expect(textInput).toHaveLength(1);
    expect(textInput[0]!.props.accessibilityHint).toBe('Enter a valid access token.');

    for (const testID of ['invalid-mode-option', 'invalid-toggle']) {
      const control = findPressable(testID);
      expect(control.props.accessibilityHint).toBeTruthy();
    }

    const messages = renderer!.root.findAll((node) => (
      node.type === 'Text' && node.props.accessibilityRole === 'alert'
    ));
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message.props.nativeID).toBeTruthy();
      expect(message.props.accessibilityLiveRegion).toBe('polite');
    }
  });

  it('combines punctuated field descriptions and issues without duplicate punctuation', async () => {
    const context = createSurfaceContext({ platform: 'ios' });
    await act(async () => {
      renderer = create(
        <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
          <Form.Field
            label="Access token"
            description="Used to connect."
            issue="Enter a valid token."
          >
            <Form.TextField testID="described-invalid-token" label="Access token" value="" onChange={() => undefined} />
          </Form.Field>
        </PluginUiProvider>,
      );
    });

    const input = renderer!.root.find((node) => (
      node.type === 'TextInput' && node.props.testID === 'described-invalid-token'
    ));
    expect(input.props.accessibilityHint).toBe('Used to connect. Enter a valid token.');
  });
});
