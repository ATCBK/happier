import * as React from 'react';
import { Button, Popover, Select, Stack, useHappierCollectionLayout } from '@happier-dev/plugin-ui';

import {
  CORPUS_SMART_PRECEDENCE_TUPLES_V1,
  type CorpusSmartPolicyV1,
} from '../../corpus/query/smartPolicy.js';
import type { TriageFilterFacetValueV1, TriageSurfaceStateV1 } from '../state/surface.js';
import type { TriageTextResolverV1 } from '../shell/windowState.js';
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
 * **One composition at every width (D4-A, 2026-10-11).** The five facets sit
 * behind one labelled **Filters** trigger presented by the public `Popover`, so
 * the portal, the initial focus, dismissal, focus return, Escape and Android
 * Back are the host's — Triage supplies one grouped five-facet form and nothing
 * else. Every selected value is already said, and removable, as a token in the
 * list's search field (the shell's `searchTokens`), so a toolbar pill per facet
 * would state each constraint twice and turn the lab's one calm search row into
 * a row of grey pills. §6 allows the facets to stay exposed on wide layouts; it
 * does not require it, and the tokens are what keep the narrowing visible.
 *
 * **Views and Order are never folded in.** The table puts Order in its title
 * column; list and board keep the toolbar control. They are separate lens questions —
 * which saved lens this is, and which ladder ranks it — and a reader who has to
 * open a Filters overlay to reorder the list has lost both.
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

/**
 * Which value one press changed.
 *
 * The public multi-select control reports the whole next selection, while the
 * reducer owns the toggle so that "one facet never weakens another" has one
 * enforcement point. The difference between the two selections is therefore
 * read here and handed back as facet values — never as a replacement selection,
 * which would make this file a second filter authority.
 */
function toggledKeys(
  selected: readonly string[],
  next: readonly (string | Readonly<unknown>)[],
): readonly string[] {
  const nextKeys = next.filter((value): value is string => typeof value === 'string');
  const before = new Set(selected);
  const after = new Set(nextKeys);
  return [
    ...nextKeys.filter((key) => !before.has(key)),
    ...selected.filter((key) => !after.has(key)),
  ];
}

function TriageFilterFacetControl(props: Readonly<{
  facet: TriageFilterFacetPlanV1;
  onToggleFilterValue: (selection: TriageFilterFacetValueV1) => void;
}>): React.ReactElement | null {
  const { facet, onToggleFilterValue } = props;
  const selected = React.useMemo(
    () => facet.options.filter((option) => option.selected).map((option) => option.key),
    [facet.options],
  );
  const onChange = React.useCallback((value: unknown) => {
    const next = Array.isArray(value) ? value : [value];
    for (const key of toggledKeys(selected, next as readonly string[])) {
      const option = facet.options.find((candidate) => candidate.key === key);
      // Nothing is parsed back out of a key: the plan carries the exact facet
      // value beside it, so one press can only ever name the value it planned.
      if (option !== undefined) onToggleFilterValue(option.selection);
    }
  }, [facet.options, onToggleFilterValue, selected]);

  // A facet with nothing to offer renders nothing rather than an empty control
  // the reader can focus and not use.
  if (facet.options.length === 0) return null;
  return (
    <Select
      label={facet.label}
      presentation="inline"
      multiple
      value={selected}
      options={facet.options.map((option) => ({ value: option.key, label: option.label }))}
      onChange={onChange}
    />
  );
}

/**
 * The lens: one **Filters** trigger. Every selected constraint stays
 * named and removable as a token in the list's search field (the shell's
 * `searchTokens`), the one place both arms say it.
 *
 * The open state belongs to this component, the one place the overlay is
 * presented from.
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
  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger={activeCount === 0 ? label : `${label} · ${activeCount}`}
        // Quiet words that open a menu (lab: the lens is said in the search, not by filled pills).
        triggerAppearance="text"
        triggerDisclosure
        triggerAccessibilityLabel={label}
      >
        {/*
          One grouped form, and only the five facets. The overlay's layer,
          focus and dismissal are the host's; this is the content it presents.
        */}
        <Stack gap="small">
          {facets.map((facet) => (
            <TriageFilterFacetControl
              key={facet.facet}
              facet={facet}
              onToggleFilterValue={onToggleFilterValue}
            />
          ))}
        </Stack>
      </Popover>
    </>
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
