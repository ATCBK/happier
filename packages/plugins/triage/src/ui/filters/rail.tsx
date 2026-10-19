import * as React from 'react';
import { Button, Menu, Select, useHappierCollectionLayout, type CollectionToolbarProps, type MenuGroup } from '@happier-dev/plugin-ui';

import {
  CORPUS_SMART_PRECEDENCE_TUPLES_V1,
  type CorpusSmartPolicyV1,
} from '../../corpus/query/smartPolicy.js';
import type { TriageFilterFacetValueV1, TriageSurfaceStateV1 } from '../state/surface.js';
import type { TriageListShellStateV1, TriageTextResolverV1 } from '../shell/windowState.js';
import type { TriageFilterFacetPlanV1 } from './plan.js';

/**
 * The one lens control group (`core/SURFACE.md` §6).
 *
 * Every control here is the shared public option control, so the roving focus,
 * the checked/selected semantics, the platform touch-target floor and the
 * disabled treatment are all owned by `plugin-ui` and reached through props.
 * Triage decides only which already-projected words go in which control and
 * which reducer action one press means — there is no Triage Pressable, chip
 * component, popover or focus handling in this file.
 *
 * **One composition on a wide page (D4-A, 2026-10-11).** The five facets sit
 * behind one labelled **Filters** trigger presented by the public `Menu` of
 * labelled checkbox groups, so the portal, the initial focus, dismissal, focus
 * return, Escape and Android Back are the host's — Triage supplies the groups
 * and nothing else. Every selected value is already said, and removable, as a token in the
 * list's search field (the shell's `searchTokens`), so a toolbar pill per facet
 * would state each constraint twice and turn the lab's one calm search row into
 * a row of grey pills. §6 allows the facets to stay exposed on wide layouts; it
 * does not require it, and the tokens are what keep the narrowing visible.
 *
 * **Views and Order stay separate on a wide page.** The table puts Order in its title
 * column; list and board keep the toolbar control. They are separate lens questions —
 * which saved lens this is, and which ladder ranks it.
 *
 * **On a phone the shared `CollectionToolbar` folds narrowing and order behind one
 * round, counted Filters button** (lab `merged-list-phone`) that opens the shared
 * bottom sheet: `readTriageFilterSheetV1` hands it the same facet groups the wide
 * menu draws (`readTriageFacetMenuGroupsV1`), plus Order and Smart order as radio
 * groups and Clear filters. Views stays in the toolbar at every width.
 */

export type TriageFilterRailPropsV1 = Readonly<{
  facets: readonly TriageFilterFacetPlanV1[];
  order: TriageSurfaceStateV1['order'];
  smartPolicy: CorpusSmartPolicyV1;
  /**
   * Whether any FACET is selected — not whether the window is narrowed. It
   * decides only whether **Clear filters** is offered, and that control clears
   * facets: a route-carried query narrows the list too, but a button that says
   * it clears filters and leaves the query would be a control that does
   * nothing.
   */
  filtered: boolean;
  text: TriageTextResolverV1;
  onToggleFilterValue: (selection: TriageFilterFacetValueV1) => void;
  onClearFilters: () => void;
  onChangeOrder: (order: TriageSurfaceStateV1['order']) => void;
  onChangeSmartPolicy: (smartPolicy: CorpusSmartPolicyV1) => void;
}>;

const ORDER_COPY: readonly (readonly [TriageSurfaceStateV1['order'], string, string])[] = [
  ['newest', 'plugins.triage.surface.order.newest', 'Newest'],
  ['oldest', 'plugins.triage.surface.order.oldest', 'Oldest'],
  ['smart', 'plugins.triage.surface.order.smart', 'Smart'],
];

/** The same named ladders for the toolbar and the Collection's table title. */
export function readTriageOrderOptionsV1(text: TriageTextResolverV1): readonly Readonly<{
  key: TriageSurfaceStateV1['order'];
  label: string;
}>[] {
  return ORDER_COPY.map(([key, labelKey, fallback]) => ({ key, label: text(labelKey, fallback) }));
}

/**
 * The two closed Smart ladders, named by what the reader actually gets.
 *
 * The stored value is a precedence tuple, and its first predicate names the
 * whole ladder — so these are two options over one canonical vocabulary rather
 * than a policy editor.
 */
const SMART_PRECEDENCE_COPY: readonly (readonly [
  CorpusSmartPolicyV1['precedence'][number],
  string,
  string,
])[] = [
  ['attention', 'plugins.triage.surface.smartPolicy.attentionFirst', 'What needs you first'],
  ['activity', 'plugins.triage.surface.smartPolicy.activityFirst', 'Most recent activity first'],
];

/** The facets as the shared menu's named checkbox groups: the wide Filters menu and the phone sheet draw these. */
export function readTriageFacetMenuGroupsV1(facets: readonly TriageFilterFacetPlanV1[]): readonly MenuGroup[] {
  // An option key is unique across the whole rail (`plan.ts`), so it is the menu row's identity.
  return facets
    .filter((facet) => facet.options.length > 0)
    .map((facet) => ({
      id: facet.facet,
      accessibilityLabel: facet.label,
      items: facet.options.map((option) => ({
        id: option.key,
        label: option.label,
        kind: 'checkbox' as const,
        checked: option.selected,
      })),
    }));
}

/** One pressed row back to the facet value it planned: nothing is parsed back out of a key. */
function toggleFacetRow(
  facets: readonly TriageFilterFacetPlanV1[],
  key: string,
  onToggleFilterValue: (selection: TriageFilterFacetValueV1) => void,
): void {
  for (const facet of facets) {
    const option = facet.options.find((candidate) => candidate.key === key);
    if (option !== undefined) onToggleFilterValue(option.selection);
  }
}

const ORDER_ROW_PREFIX = 'triage-order:';
const SMART_ROW_PREFIX = 'triage-smart:';

/**
 * The phone's Filters sheet (`CollectionToolbar` `refine.sheet`): the wide menu's facet groups, then Order (and
 * Smart order beside Smart) as radio groups, Clear filters while a facet is selected, and "Show N results".
 */
export function readTriageFilterSheetV1(props: Omit<TriageFilterRailPropsV1, 'text'> & Readonly<{
  text: TriageTextResolverV1;
  resultCount: number;
  windowState: TriageListShellStateV1;
}>): NonNullable<CollectionToolbarProps['refine']>['sheet'] {
  const { facets, order, smartPolicy, text } = props;
  const orderLabel = text('plugins.triage.surface.order', 'Order');
  const smartLabel = text('plugins.triage.surface.smartPolicy', 'Smart order');
  const groups: MenuGroup[] = [
    ...readTriageFacetMenuGroupsV1(facets),
    {
      id: 'order',
      accessibilityLabel: orderLabel,
      items: readTriageOrderOptionsV1(text).map(({ key, label }) => ({
        id: `${ORDER_ROW_PREFIX}${key}`, label, kind: 'radio' as const, radioGroupId: 'order',
      })),
    },
    ...(order === 'smart' ? [{
      id: 'smart',
      accessibilityLabel: smartLabel,
      items: SMART_PRECEDENCE_COPY.map(([value, key, fallback]) => ({
        id: `${SMART_ROW_PREFIX}${value}`, label: text(key, fallback), kind: 'radio' as const, radioGroupId: 'smart',
      })),
    }] : []),
  ];
  // Coverage is the window owner's fact, including a cold/unavailable window.
  // Filtering never turns a loaded subset into an authoritative total.
  const showResults = props.windowState.kind === 'initial'
    ? text('plugins.triage.surface.filters.showUnsynchronized', 'Show results · Not yet synchronized')
    : props.windowState.kind === 'unavailable' || props.windowState.kind === 'sourcesUnreachable'
      ? text('plugins.triage.surface.filters.showUnavailable', 'Show results · Unavailable')
      : props.windowState.kind === 'window' && props.windowState.window.coverage !== 'complete'
        ? props.resultCount === 1
          ? text('plugins.triage.surface.filters.showPartialResult', 'Show 1 result so far')
          : text('plugins.triage.surface.filters.showPartialResults', 'Show {count} results so far').replace('{count}', String(props.resultCount))
        : props.resultCount === 1
          ? text('plugins.triage.surface.filters.showResult', 'Show 1 result')
          : text('plugins.triage.surface.filters.showResults', 'Show {count} results').replace('{count}', String(props.resultCount));
  return {
    groups,
    radioGroups: [
      { id: 'order', accessibilityLabel: orderLabel, selectedId: `${ORDER_ROW_PREFIX}${order}` },
      ...(order === 'smart'
        ? [{ id: 'smart', accessibilityLabel: smartLabel, selectedId: `${SMART_ROW_PREFIX}${smartPolicy.precedence[0]}` }]
        : []),
    ],
    onSelect: (id) => {
      if (id.startsWith(ORDER_ROW_PREFIX)) {
        const match = ORDER_COPY.find(([candidate]) => `${ORDER_ROW_PREFIX}${candidate}` === id);
        if (match !== undefined) props.onChangeOrder(match[0]);
        return;
      }
      if (id.startsWith(SMART_ROW_PREFIX)) {
        const tuple = CORPUS_SMART_PRECEDENCE_TUPLES_V1.find((candidate) => `${SMART_ROW_PREFIX}${candidate[0]}` === id);
        if (tuple !== undefined) props.onChangeSmartPolicy({ v: 1, precedence: tuple });
        return;
      }
      toggleFacetRow(facets, id, props.onToggleFilterValue);
    },
    ...(props.filtered
      ? { clear: { label: text('plugins.triage.surface.filters.clear', 'Clear filters'), onPress: props.onClearFilters } }
      : {}),
    showResultsLabel: showResults,
  };
}

/**
 * The lens: one **Filters** trigger. Every selected constraint stays
 * named and removable as a token in the list's search field (the shell's
 * `searchTokens`), the one place both arms say it.
 *
 * It is the public `Menu` of labelled checkbox groups: the shared menu rows are the compact,
 * scrolling, keyboard-roving form of "pick several of each", and a choice leaves the menu open
 * for the next. The Menu owns the overlay's layer, focus and dismissal.
 */
function TriageCompactFilters(props: Readonly<{
  facets: readonly TriageFilterFacetPlanV1[];
  text: TriageTextResolverV1;
  onToggleFilterValue: (selection: TriageFilterFacetValueV1) => void;
}>): React.ReactElement {
  const { facets, onToggleFilterValue, text } = props;
  const [open, setOpen] = React.useState(false);
  const label = text('plugins.triage.surface.filters', 'Filters');
  const activeCount = facets.reduce(
    (count, facet) => count + facet.options.filter((option) => option.selected).length,
    0,
  );
  const groups = readTriageFacetMenuGroupsV1(facets);
  const onSelect = React.useCallback((key: string) => {
    toggleFacetRow(facets, key, onToggleFilterValue);
  }, [facets, onToggleFilterValue]);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      trigger={activeCount === 0 ? label : `${label} · ${activeCount}`}
      // Quiet words that open a menu (lab: the lens is said in the search, not by filled pills).
      triggerAppearance="text"
      triggerDisclosure
      triggerAccessibilityLabel={label}
      groups={groups}
      showGroupLabels
      onSelect={onSelect}
    />
  );
}

export function TriageFilterRail(props: TriageFilterRailPropsV1): React.ReactElement {
  const layout = useHappierCollectionLayout();
  const {
    facets,
    filtered,
    onChangeOrder,
    onChangeSmartPolicy,
    onClearFilters,
    onToggleFilterValue,
    order,
    smartPolicy,
    text,
  } = props;

  const onOrderChange = React.useCallback((value: unknown) => {
    const match = ORDER_COPY.find(([candidate]) => candidate === value);
    if (match !== undefined) onChangeOrder(match[0]);
  }, [onChangeOrder]);

  const onPrecedenceChange = React.useCallback((value: unknown) => {
    const tuple = CORPUS_SMART_PRECEDENCE_TUPLES_V1.find((candidate) => candidate[0] === value);
    if (tuple !== undefined) onChangeSmartPolicy({ v: 1, precedence: tuple });
  }, [onChangeSmartPolicy]);

  return (
    <>
      <TriageCompactFilters
        facets={facets}
        text={text}
        onToggleFilterValue={onToggleFilterValue}
      />
      {layout?.composition !== 'table' ? <Select
        label={text('plugins.triage.surface.order', 'Order')}
        presentation="menu"
        value={order}
        options={readTriageOrderOptionsV1(text).map(({ key, label }) => ({ value: key, label }))}
        onChange={onOrderChange}
      /> : null}
      {/*
        Only beside Smart. The precedence is retained across an order change so
        the preference survives, but a control that visibly reorders nothing is
        a control that lies about what it does.
      */}
      {order === 'smart' ? (
        <Select
          label={text('plugins.triage.surface.smartPolicy', 'Smart order')}
          presentation="menu"
          value={smartPolicy.precedence[0]}
          options={SMART_PRECEDENCE_COPY.map(([value, key, fallback]) => ({
            value,
            label: text(key, fallback),
          }))}
          onChange={onPrecedenceChange}
        />
      ) : null}
      {filtered ? (
        <Button
          titleKey="plugins.triage.surface.filters.clear"
          title="Clear filters"
          variant="plain"
          onPress={onClearFilters}
        />
      ) : null}
    </>
  );
}
