import { act, useState, type ReactNode } from 'react';
import { Dimensions, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import type { HappierUiPalette } from '../environment/types.js';
import type { HappierLayoutChangeEvent } from '../presentation/portableTypes.js';
import type { PluginUiPresentationHost } from '../presentationHost/context.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { HAPPIER_EMPTY_STATE_FRAME } from '../presentation/state/InfoState.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Button } from './Button.js';
import { Item, ItemGroup, List } from './List.js';
import { PageHeader } from './PageHeader.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';
import { EmptyState } from './State.js';
import { Select } from './Form.js';

/**
 * Configuration-surfaces U9: a plugin page composes the same anatomy as
 * Happier's own settings pages — a page header, sentence-case sections with
 * their explanation above one hairline sheet, rows divided by full-width
 * hairlines, and page empty states — through the shared presentation owners
 * Happier core renders with.
 */
const PALETTE: HappierUiPalette = {
  page: '#fafafa',
  sheet: '#f1f2f3',
  sheetBorder: '#0a0b0c',
  rowDivider: '#070809',
  groupDivider: '#0d0e0f',
  controlBorder: '#d6d6d6',
  fieldBackground: '#ffffff',
  placeholder: '#999999',
  selection: '#111111',
  switchTrackOn: '#1976d2',
  switchTrackOff: '#dddddd',
  switchThumb: '#ffffff',
  segmentTrack: '#eeeeee',
  segmentThumb: '#ffffff',
  navigationSelected: '#e8e8e8',
  navigationHover: '#efefef',
};

function mountPage(children: ReactNode, host: Partial<PluginUiPresentationHost> = {}) {
  const context = createSurfaceContext();
  const presentationHost = {
    palette: PALETTE,
    renderMarkdown: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
    ...host,
  } as unknown as PluginUiPresentationHost;
  return mountThroughReactNativeWeb(
    <PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={presentationHost}>
      {children}
    </PluginUiProviderInternal>,
  );
}

function textOf(element: Element | null | undefined): string {
  return element?.textContent?.trim() ?? '';
}

describe('plugin page anatomy through the shared page owners', () => {
  it('keeps a compact identity glyph on the same title edge as a standard page-row glyph', () => {
    const mount = mountPage(
      <ItemGroup title="Devices">
        <Item title="Compact identity" icon={<View testID="compact-glyph" style={{ width: 16, height: 16 }} />} />
        <Item title="Standard identity" icon={<View testID="standard-glyph" style={{ width: HAPPIER_PAGE_METRICS.rowLeadingColumnPx, height: HAPPIER_PAGE_METRICS.rowLeadingColumnPx }} />} />
        <Item title="Larger identity" icon={<View testID="larger-glyph" style={{ width: 24, height: 24 }} />} />
      </ItemGroup>,
    );
    try {
      // Read the rendered layout constraint, not the authored component's props. A smaller glyph
      // must retain the page's leading column so its title aligns with the standard row below it.
      const leadingWidth = (id: string) => {
        const glyph = mount.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
        const column = getComputedStyle(glyph.parentElement!);
        const fixedWidth = Number.parseFloat(column.width);
        if (Number.isFinite(fixedWidth)) return fixedWidth;
        return Math.max(Number.parseFloat(getComputedStyle(glyph).width), Number.parseFloat(column.minWidth) || 0);
      };
      expect(leadingWidth('compact-glyph')).toBe(leadingWidth('standard-glyph'));
      expect(leadingWidth('larger-glyph')).toBeGreaterThan(leadingWidth('standard-glyph'));
    } finally { mount.unmount(); }
  });

  it('lets an explicit radio-group name override its visible title', () => {
    const mount = mountPage(
      <ItemGroup title="Use" accessibilityRole="radiogroup" accessibilityLabel="Checkout preparation">
        <List.Item title="A fresh clone" accessibilityRole="radio" onPress={() => undefined} />
      </ItemGroup>,
    );
    expect(mount.container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Checkout preparation');
    mount.unmount();
  });

  it('rejects a radio group with neither a title nor an explicit name', () => {
    expect(() => mountPage(
      <ItemGroup accessibilityRole="radiogroup">
        <List.Item title="A fresh clone" accessibilityRole="radio" onPress={() => undefined} />
      </ItemGroup>,
    )).toThrow(/accessible name/i);
  });

  it('draws a titled ItemGroup as a page section: heading and description above one sheet, hairlines between rows only', () => {
    const mount = mountPage(
      <ItemGroup title="Sync" description="How often the plugin checks for new issues." testID="section">
        <Item title="Interval" subtitle="Every 5 minutes" />
        <Item title="Only while open" />
        <Item title="Notify me" />
      </ItemGroup>,
    );

    const section = mount.container.querySelector('[data-testid="section"]')!;
    const heading = section.querySelector('[role="heading"]');
    expect(textOf(heading)).toBe('Sync');
    const text = textOf(section);
    // The explanation is read before the rows, never as a footer under them.
    expect(text.indexOf('How often the plugin checks')).toBeLessThan(text.indexOf('Interval'));

    const separators = Array.from(section.querySelectorAll<HTMLElement>('[role="separator"]'));
    expect(separators).toHaveLength(2);
    for (const separator of separators) {
      expect(separator.style.backgroundColor).toBe('rgb(7, 8, 9)');
    }

    const sheet = Array.from(section.querySelectorAll<HTMLElement>('div'))
      .find((element) => element.style.borderTopLeftRadius === '14px');
    expect(sheet, 'the rows sit on one rounded page sheet').toBeDefined();
    expect(sheet?.style.borderTopColor).toBe('rgb(10, 11, 12)');
    // The group is named by its title for assistive technology.
    expect(section.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Sync');
    mount.unmount();
  });

  it('keeps an untitled ItemGroup a semantic group with no sheet, heading or dividers', () => {
    const mount = mountPage(
      <ItemGroup accessibilityLabel="Quick actions" testID="group">
        <Item title="Reload" />
        <Item title="Open logs" />
      </ItemGroup>,
    );

    const group = mount.container.querySelector('[data-testid="group"]')!;
    expect(group.querySelector('[role="heading"]')).toBeNull();
    expect(group.querySelectorAll('[role="separator"]')).toHaveLength(0);
    expect(Array.from(group.querySelectorAll<HTMLElement>('div')).some((element) => element.style.borderTopLeftRadius === '14px'))
      .toBe(false);
    mount.unmount();
  });

  it('keeps radio roving through a titled section sheet', async () => {
    function Harness() {
      const [selected, setSelected] = useState<'daily' | 'weekly'>('daily');
      return (
        <ItemGroup title="Digest" accessibilityRole="radiogroup">
          <List.Item title="Daily" accessibilityRole="radio" selected={selected === 'daily'} onPress={() => setSelected('daily')} />
          <List.Item title="Weekly" accessibilityRole="radio" selected={selected === 'weekly'} onPress={() => setSelected('weekly')} />
        </ItemGroup>
      );
    }
    const mount = mountPage(<Harness />);
    const radios = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(radios.map((radio) => radio.getAttribute('tabindex'))).toEqual(['0', '-1']);

    await act(async () => {
      radios[0]?.focus();
      radios[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });

    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(mount.container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Digest');
    mount.unmount();
  });

  it('draws the page header title as the page heading with its purpose, meta line and actions', () => {
    const mount = mountPage(
      <PageHeader
        title="Sentry"
        description="Link Sentry issues to the sessions that fix them."
        meta={[{ key: 'version', text: 'v2.4.0' }, { key: 'org', text: 'acme' }]}
        actions={<Button title="Disconnect" onPress={() => undefined} />}
        testID="header"
      />,
    );

    const header = mount.container.querySelector('[data-testid="header"]')!;
    expect(textOf(header.querySelector('[role="heading"]'))).toBe('Sentry');
    expect(textOf(header)).toContain('Link Sentry issues to the sessions that fix them.');
    expect(textOf(header.querySelector('[data-testid="header-meta"]'))).toBe('v2.4.0·acme');
    expect(textOf(header)).toContain('Disconnect');
    mount.unmount();
  });

  it('keeps each meta separator with the fact before it so a wrapped line never starts with one', () => {
    const mount = mountPage(
      <PageHeader
        title="Run"
        meta={[{ key: 'origin', text: 'Scheduled', testID: 'f1' }, { key: 'machine', text: 'mac', testID: 'f2' }, { key: 'time', text: '13:50', testID: 'f3' }]}
        testID="header"
      />,
    );
    // Each fact is one wrapping unit: a unit that began with "·" would orphan it at a line start.
    expect(['f1', 'f2', 'f3'].map((id) => textOf(mount.container.querySelector(`[data-testid="${id}"]`))))
      .toEqual(['Scheduled·', 'mac·', '13:50']);
    mount.unmount();
  });

  it('leaves the title to host chrome that already shows it and places the host back control', () => {
    const shown = mountPage(
      <PageHeader title="Sentry" description="Link Sentry issues." testID="header" />,
      { pageChrome: { showsTitle: true, renderBack: () => <button data-testid="host-back" /> } },
    );
    const header = shown.container.querySelector('[data-testid="header"]')!;
    expect(header.querySelector('[role="heading"]')).toBeNull();
    expect(textOf(header)).toBe('Link Sentry issues.');
    // No title line, so no back beside it: the host chrome carries both.
    expect(header.querySelector('[data-testid="host-back"]')).toBeNull();
    shown.unmount();

    const own = mountPage(
      <PageHeader title="Sentry" testID="header" />,
      { pageChrome: { showsTitle: false, renderBack: () => <button data-testid="host-back" /> } },
    );
    const ownHeader = own.container.querySelector('[data-testid="header"]')!;
    expect(textOf(ownHeader.querySelector('[role="heading"]'))).toBe('Sentry');
    expect(ownHeader.querySelector('[data-testid="host-back"]')).not.toBeNull();
    own.unmount();
  });

  it('places host page actions beside the desktop title even when the plugin declares no actions', () => {
    const mount = mountPage(<PageHeader title="Sentry" testID="header" />, {
      pageChrome: {
        showsTitle: false,
        renderNavigationActions: (actions: ReactNode) => <><button data-testid="execution-origin">Runs on · Workstation</button>{actions}</>,
      },
    });
    expect(mount.container.querySelector('[data-testid="header"] [data-testid="execution-origin"]')).not.toBeNull();
    expect(mount.container.querySelectorAll('[data-testid="execution-origin"]')).toHaveLength(1);
    mount.unmount();
  });

  it('keeps a page row control on the row inset, and moves a wide one beneath its label on a narrow row', () => {
    const mount = mountPage(
      <ItemGroup title="Reviews">
        <Item
          testID="depth-row"
          title="Depth"
          accessory={<View testID="depth-control" />}
          accessoryOutsidePressable
          accessoryWraps
        />
      </ItemGroup>,
    );
    const row = mount.container.querySelector('[data-testid="depth-row"]')!;
    const control = () => mount.container.querySelector<HTMLElement>('[data-testid="depth-control"]')!.parentElement!;
    const onLayout = (row as unknown as { __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void }).__reactLayoutHandler;
    expect(onLayout, 'a row with a wide control measures itself').toBeDefined();

    act(() => onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width: 900, height: 52 } } }));
    // Beside the label: the control keeps the row's trailing inset instead of touching the sheet edge.
    expect(control().style.paddingRight).toBe(`${HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx}px`);

    act(() => onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 52 } } }));
    // Too narrow for both: the control drops beneath the label, on the label's edge.
    expect(control().style.paddingLeft).toBe(`${HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx}px`);
    expect(control().style.alignSelf).toBe('stretch');
    mount.unmount();
  });

  it('keeps a short page operation beside its label on a narrow row, and moves it beneath only when it would squeeze the label', () => {
    const mount = mountPage(
      <ItemGroup title="Machines">
        <Item testID="where-row" title="Where" accessory={<View testID="where-control" />} accessoryOutsidePressable />
      </ItemGroup>,
    );
    const row = mount.container.querySelector<HTMLElement>('[data-testid="where-row"]')!;
    const container = () => mount.container.querySelector<HTMLElement>('[data-testid="where-control"]')!.parentElement!;
    const handler = (node: Element) => (node as unknown as { __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void }).__reactLayoutHandler;
    const layout = (node: Element, width: number) => act(() => handler(node)!({ nativeEvent: { layout: { x: 0, y: 0, width, height: 52 } } }));
    layout(row, 390);
    expect(handler(container()), 'an inline page operation reports its natural width').toBeDefined();
    // A short button (Change): the label keeps its 200 px column, so the button stays on its line.
    layout(container(), 90 + HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx);
    expect(container().style.alignSelf).not.toBe('stretch');
    // A wide one would leave the label less than its column: it moves beneath, on the label's edge.
    layout(container(), 260 + HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx);
    expect(container().style.alignSelf).toBe('stretch');
    expect(container().style.paddingLeft).toBe(`${HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx}px`);
    mount.unmount();
  });

  it.each([
    { viewportWidth: 1280, viewportHeight: 900, rowWidth: 481, trailing: true },
    { viewportWidth: 430, viewportHeight: 932, rowWidth: 398, trailing: false },
  ])('fits a page select beside its label in a desktop column and below it on a phone ($viewportWidth)', ({ viewportWidth, viewportHeight, rowWidth, trailing }) => {
    const getDimensions = Dimensions.get.bind(Dimensions);
    let viewport = { width: viewportWidth, height: viewportHeight, scale: 1, fontScale: 1 };
    const dimensions = vi.spyOn(Dimensions, 'get').mockImplementation((name) => name === 'window'
      ? viewport
      : getDimensions(name));
    const mount = mountPage(
      <ItemGroup title="Acquisition">
        <Item
          testID="strategy-row"
          title="Strategy"
          accessoryWraps
          fieldAccessory
          accessoryOutsidePressable
          accessory={<Select
            label="Strategy"
            presentation="field"
            value="round-robin"
            options={[{ value: 'priority', label: 'Priority order' }, { value: 'round-robin', label: 'Round robin' }]}
            onChange={() => undefined}
          />}
        />
      </ItemGroup>,
    );
    try {
      const row = mount.container.querySelector<HTMLElement>('[data-testid="strategy-row"]')!;
      const layout = (row as unknown as { __reactLayoutHandler: (event: HappierLayoutChangeEvent) => void }).__reactLayoutHandler;
      const trigger = mount.container.querySelector<HTMLElement>('[role="button"][aria-label="Strategy: Round robin"]')!;
      expect(trigger).not.toBeNull();
      act(() => layout({ nativeEvent: { layout: { x: 0, y: 0, width: rowWidth, height: 52 } } }));

      const composition = row.firstElementChild as HTMLElement;
      expect(composition.style.flexDirection).toBe(trailing ? 'row' : 'column');
      const field = trigger.firstElementChild as HTMLElement;
      expect(getComputedStyle(field).width).not.toBe('240px');
      if (trailing) {
        expect(Array.from(trigger.querySelectorAll<HTMLElement>('div')).some((node) => getComputedStyle(node).maxWidth === '237px')).toBe(true);
        // A host can resize around a fixed-width pane: the row width alone has not changed.
        viewport = { width: 430, height: 932, scale: 1, fontScale: 1 };
        act(() => layout({ nativeEvent: { layout: { x: 0, y: 0, width: rowWidth, height: 52 } } }));
        expect(composition.style.flexDirection).toBe('column');
        viewport = { width: viewportWidth, height: viewportHeight, scale: 1, fontScale: 1 };
        act(() => layout({ nativeEvent: { layout: { x: 0, y: 0, width: rowWidth, height: 52 } } }));
        expect(composition.style.flexDirection).toBe('row');
        act(() => layout({ nativeEvent: { layout: { x: 0, y: 0, width: 370, height: 52 } } }));
        expect(composition.style.flexDirection).toBe('column');
      }
      // Recomposition must retain the trigger and its focus/menu owner.
      expect(mount.container.querySelector('[role="button"][aria-label="Strategy: Round robin"]')).toBe(trigger);
      expect(trigger.textContent).toContain('Round robin');
    } finally {
      mount.unmount();
      dimensions.mockRestore();
    }
  });

  it('draws an empty page in the page frame and an empty list as one quiet line', () => {
    const mount = mountPage(
      <>
        <EmptyState layout="page" title="No projects yet" description="Projects you link appear here." testID="page-empty" />
        <EmptyState layout="page" variant="add" title="No webhooks yet" testID="page-add-empty" />
        <ItemGroup title="Projects">
          <EmptyState layout="line" title="No matches" testID="line-empty" />
        </ItemGroup>
        <EmptyState variant="add" title="Add a webhook" testID="add-empty" />
      </>,
    );

    // The page frame is the shared empty-state owner's, on the sheets' edges.
    const page = mount.container.querySelector<HTMLElement>('[data-testid="page-empty"]')!;
    expect(page.style.paddingTop).toBe(`${HAPPIER_EMPTY_STATE_FRAME.page.paddingTop}px`);
    expect(page.style.marginLeft).toBe(`${HAPPIER_PAGE_METRICS.sheetInsetPx}px`);
    // Only an invitation to add is framed (dashed means "add something here").
    expect(page.style.borderTopStyle).not.toBe('dashed');
    const pageAdd = mount.container.querySelector<HTMLElement>('[data-testid="page-add-empty"]')!;
    expect(pageAdd.style.borderTopStyle).toBe('dashed');
    expect(pageAdd.style.borderTopColor).toBe('rgb(10, 11, 12)');

    const line = mount.container.querySelector<HTMLElement>('[data-testid="line-empty"]')!;
    expect(textOf(line)).toBe('No matches');
    // ItemGroup is a group, not a list. An empty-state sentence is not a collection item
    // and stays quiet unless its caller requests a lifecycle announcement.
    expect(line.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Projects');
    expect(line.getAttribute('role')).toBeNull();
    expect(line.getAttribute('aria-live')).toBeNull();

    const add = mount.container.querySelector<HTMLElement>('[data-testid="add-empty"]')!;
    expect(add.style.borderTopStyle).toBe('dashed');
    expect(add.style.borderTopColor).toBe('rgb(10, 11, 12)');
    mount.unmount();
  });
});
