import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

// Device class is the platform boundary; everything beneath it stays real.
let device: 'phone' | 'desktop' = 'phone';
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
  useDeviceType: () => device,
}));

const { SelectionListFilterChip } =
  await import('@/components/ui/selectionList/SelectionListFilterChips');
const { SelectionList } =
  await import('@/components/ui/selectionList/SelectionList');
const { UsageFilterBar } = await import('./UsageFilterBar');
const { USAGE_SCOPE_FILTER_ALL } = await import('./useUsageWidgetPageFilters');

afterEach(() => {
  standardCleanup();
  device = 'phone';
});

type Bar = React.ComponentProps<typeof UsageFilterBar>;
const page = {
  period: '7days',
  scope: { costBasis: 'auto' },
} as const satisfies Readonly<{
  period: Bar['page']['period'];
  scope: Pick<Bar['page']['scope'], 'costBasis'>;
}>;

function renderBar(selections: string[]) {
  const filter = (
    field: 'sources' | 'agents',
    selected: string[],
    options: { id: string; label: string }[],
  ) => ({
    field,
    title: field,
    selected,
    options: [
      { id: USAGE_SCOPE_FILTER_ALL, label: `All ${field}` },
      ...options,
    ],
    select: (id: string) => {
      selections.push(`${field}:${id}`);
      return true;
    },
  });
  const props = {
    page: page as unknown as Bar['page'],
    slices: [],
    scopeFilters: [
      filter('sources', [], [{ id: 'runtime', label: 'Happier sessions' }]),
      filter(
        'agents',
        ['claude'],
        [
          { id: 'claude', label: 'Claude' },
          { id: 'codex', label: 'Codex' },
        ],
      ),
    ],
    costBasisOptions: ['auto'],
    onPeriodChange: async () => true,
    onCostBasisChange: async () => true,
    metric: 'tokens',
    onMetricChange: null,
    testID: 'filters',
  } satisfies Bar;
  return renderScreen(<UsageFilterBar {...props} />);
}

describe('UsageFilterBar', () => {
  it('collapses every scope filter into one Filters chooser on a phone, keeping each choice and the narrowed count', async () => {
    const selections: string[] = [];
    const screen = await renderBar(selections);
    const chips = screen
      .findAllByType(SelectionListFilterChip)
      .map((chip) => chip.props.filter);
    // Period stays visible; the four scopes become one chip (lab d2filter P).
    expect(chips.map((chip) => chip.id)).toEqual(['scope']);
    expect(chips[0]!).toMatchObject({ active: true, count: '1' });

    const content = await renderScreen(
      <>
        {chips[0]!.renderPopoverContent!({ close: () => {}, maxHeight: 600 })}
      </>,
    );
    const list = content.findAllByType(SelectionList)[0]!;
    const sections = list.props.rootStep.sections;
    expect(
      sections.map((section: { title?: string }) => section.title),
    ).toEqual(['sources', 'agents']);
    expect([...list.props.selection.selectedIds].sort()).toEqual(
      ['agents\u0001claude', `sources\u0001${USAGE_SCOPE_FILTER_ALL}`].sort(),
    );
    await act(async () => {
      list.props.onSelect('agents\u0001codex');
    });
    expect(selections).toEqual(['agents:codex']);
    await content.unmount();
    await screen.unmount();
  });

  it("keeps one chip per scope on a wide screen, opening from the chip's leading edge", async () => {
    device = 'desktop';
    const screen = await renderBar([]);
    const chips = screen
      .findAllByType(SelectionListFilterChip)
      .map((chip) => chip.props.filter);
    expect(chips.map((chip) => chip.id)).toEqual(['sources', 'agents']);
    // Choosers open from the chip's leading edge (the shared chip's default), never over the navigation.
    const { Popover } = await import('@/components/ui/popover');
    expect(screen.findAllByType(Popover).every((popover) => (popover.props.portal?.anchorAlign ?? 'start') === 'start')).toBe(true);
    await screen.unmount();
  });
});
