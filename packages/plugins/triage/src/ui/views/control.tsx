import * as React from 'react';
import { Button, Dropdown, Row, Stack, Status, TextField, type MenuItem } from '@happier-dev/plugin-ui';

import {
  type CorpusSavedViewV1,
} from '../../settings/savedViews.js';
import type { TriageTextResolverV1 } from '../shell/windowState.js';
import type { TriageSavedViewLensStatusV1 } from './divergence.js';
import type { TriageSavedViewsNoticeV1 } from './useTriageSavedViews.js';

/**
 * The compact **Views** control (`core/SURFACE.md` §6.5).
 *
 * It names the lens the reader is looking through — a saved view by its own
 * name, or that same view as **Modified** once they have moved off it — and it
 * is where the five explicit operations live: select, create, rename, update
 * and delete.
 *
 * **One compact toolbar control.** The saved views and the four operations
 * live in the shared public `Dropdown`: a named radio group of views, then the
 * operations as menu actions. The roving focus, the checked semantics, the
 * dismissal and focus return are `plugin-ui`'s and the host's, reached through
 * props — there is no Triage popover, menu or focus handling in this file.
 * The trigger names the lens the reader is looking through, so the list page
 * reads as a work surface rather than a settings form.
 *
 * **It decides nothing durable.** `settings/savedViews.ts` mints the id,
 * validates every bound and owns the CAS verdict; `savedViewsCommand.ts` owns
 * what Rename and Update each save. The only bound named here is the view
 * count, imported from that owner so a Create control is not offered when the
 * next press could only be refused — the same reuse the reducer already makes
 * of the facet bound.
 */

/** The value standing for "no saved view", which is not a view id. */
const UNSAVED_VIEW_KEY = '';
const VIEWS_RADIO_GROUP = 'views';
/** Menu ids are namespaced so a view id can never collide with an operation. */
const VIEW_ITEM_PREFIX = 'view:';
const OPERATION_CREATE = 'operation:create';
const OPERATION_RENAME = 'operation:rename';
const OPERATION_UPDATE = 'operation:update';
const OPERATION_DELETE = 'operation:delete';

export type TriageViewsControlPropsV1 = Readonly<{
  views: readonly CorpusSavedViewV1[];
  /** The reducer's selected view, which is what the lens on screen came from. */
  selectedViewId: string | null;
  status: TriageSavedViewLensStatusV1;
  /** Whether this view names sources the reader no longer has configured. */
  namesUnavailableSources: boolean;
  /** A write this mount asked for has not settled. */
  busy: boolean;
  /** Why the controls cannot write, in words, or `null` when they can. */
  unavailableReason: string | null;
  /** The stored set belongs to a writer this build cannot read. */
  unreadable: boolean;
  notice: TriageSavedViewsNoticeV1 | null;
  text: TriageTextResolverV1;
  onSelectView: (viewId: string | null) => void;
  /** True only after the naming write was applied by the Account owner. */
  onCreateView: (label: string) => Promise<boolean>;
  onRenameView: (view: CorpusSavedViewV1, label: string) => Promise<boolean>;
  onUpdateView: (view: CorpusSavedViewV1) => void;
  onDeleteView: (view: CorpusSavedViewV1) => void;
}>;

type NameDraft =
  | Readonly<{ kind: 'create'; label: string }>
  | Readonly<{ kind: 'rename'; viewId: string; label: string }>;

/**
 * The Views control in two placements: the compact `control` belongs in the
 * list toolbar beside the other lens pickers, and `details` (the naming draft
 * and the Views notices) belongs on its own line under the toolbar, only while
 * there is something to say. One hook owns the draft state both read.
 */
export function useTriageViewsControl(props: TriageViewsControlPropsV1): Readonly<{
  control: React.ReactElement;
  details: React.ReactElement | null;
}> {
  const {
    busy,
    namesUnavailableSources,
    notice,
    onCreateView,
    onDeleteView,
    onRenameView,
    onSelectView,
    onUpdateView,
    selectedViewId,
    status,
    text,
    unavailableReason,
    unreadable,
    views,
  } = props;

  const [draft, setDraft] = React.useState<NameDraft | null>(null);
  const selected = React.useMemo(
    () => views.find((view) => view.viewId === selectedViewId) ?? null,
    [selectedViewId, views],
  );

  const onChangeSelection = React.useCallback((value: string) => {
    setDraft(null);
    onSelectView(value === UNSAVED_VIEW_KEY ? null : value);
  }, [onSelectView]);

  const startCreate = React.useCallback(() => { setDraft({ kind: 'create', label: '' }); }, []);
  const startRename = React.useCallback(() => {
    if (selected === null) return;
    setDraft({ kind: 'rename', viewId: selected.viewId, label: selected.label });
  }, [selected]);
  const cancelDraft = React.useCallback(() => { setDraft(null); }, []);
  const changeDraft = React.useCallback((label: string) => {
    setDraft((current) => (current === null ? current : { ...current, label }));
  }, []);
  const commitDraft = React.useCallback(async () => {
    if (draft === null || busy) return;
    // Re-read this same target after a conflict; Rename must preserve its
    // current stored lens rather than overwrite it with the original draft.
    const target = draft.kind === 'rename'
      ? views.find((view) => view.viewId === draft.viewId)
      : undefined;
    const applied = draft.kind === 'create'
      ? await onCreateView(draft.label)
      : target !== undefined && await onRenameView(target, draft.label);
    // An edit or Cancel while the write settled is a newer intent. Only the
    // exact submitted draft may be retired by this successful naming write.
    if (applied) setDraft((current) => current === draft ? null : current);
  }, [busy, draft, onCreateView, onRenameView, views]);
  const update = React.useCallback(() => {
    if (selected !== null) onUpdateView(selected);
  }, [onUpdateView, selected]);
  const remove = React.useCallback(() => {
    if (selected !== null) onDeleteView(selected);
  }, [onDeleteView, selected]);

  // A stored set this build cannot read is not an empty set the reader may
  // overwrite: every write stays refused until a build that understands it runs.
  const writable = !unreadable && unavailableReason === null && !busy;
  const [open, setOpen] = React.useState(false);
  const viewsLabel = text('plugins.triage.surface.views', 'Views');
  const noneLabel = text('plugins.triage.surface.views.none', 'No saved view');
  const items = React.useMemo((): MenuItem[] => [
    { id: VIEW_ITEM_PREFIX + UNSAVED_VIEW_KEY, label: noneLabel, kind: 'radio', radioGroupId: VIEWS_RADIO_GROUP, disabled: !writable },
    ...views.map((view): MenuItem => ({
      id: VIEW_ITEM_PREFIX + view.viewId,
      label: view.label,
      kind: 'radio',
      radioGroupId: VIEWS_RADIO_GROUP,
      disabled: !writable,
    })),
  ], [noneLabel, views, writable]);
  const operations = React.useMemo((): MenuItem[] => [
    { id: OPERATION_CREATE, label: text('plugins.triage.surface.views.save', 'Save as new view'), disabled: !writable || draft !== null },
    ...(selected === null ? [] : [
      { id: OPERATION_RENAME, label: text('plugins.triage.surface.views.rename', 'Rename'), disabled: !writable || draft !== null },
      // Nothing to save is not an operation. Offering it anyway would make an
      // explicit write look like it did nothing.
      { id: OPERATION_UPDATE, label: text('plugins.triage.surface.views.update', 'Update this view'), disabled: !writable || status !== 'modified' },
      { id: OPERATION_DELETE, label: text('plugins.triage.surface.views.delete', 'Delete'), disabled: !writable },
    ]),
  ], [draft, selected, status, text, writable]);
  const onSelectItem = React.useCallback((id: string) => {
    if (id.startsWith(VIEW_ITEM_PREFIX)) {
      onChangeSelection(id.slice(VIEW_ITEM_PREFIX.length));
      return;
    }
    if (id === OPERATION_CREATE) startCreate();
    else if (id === OPERATION_RENAME) startRename();
    else if (id === OPERATION_UPDATE) update();
    else if (id === OPERATION_DELETE) remove();
  }, [onChangeSelection, remove, startCreate, startRename, update]);
  const currentLabel = selected?.label ?? noneLabel;
  // The trigger names the lens itself. "Modified" joins it only when the lens
  // has moved off the saved view, because that is when Update means something.
  const trigger = selected === null ? viewsLabel : selected.label;

  const control = (
    <>
      <Dropdown
        open={open}
        onOpenChange={setOpen}
        trigger={trigger}
        // Quiet words that open a menu (lab: the lens is said in the search, not by filled pills).
        triggerAppearance="text"
        triggerDisclosure
        triggerAccessibilityLabel={`${viewsLabel}: ${currentLabel}`}
        radioGroups={[{
          id: VIEWS_RADIO_GROUP,
          accessibilityLabel: viewsLabel,
          selectedId: VIEW_ITEM_PREFIX + (selectedViewId ?? UNSAVED_VIEW_KEY),
        }]}
        items={items}
        groups={[{
          id: 'operations',
          accessibilityLabel: text('plugins.triage.surface.views.operations', 'View actions'),
          items: operations,
        }]}
        onSelect={onSelectItem}
      />
      {/*
        The one place the lens is named as no longer the saved one. It is said
        in words rather than by a mark on the name, because the whole point of
        the state is that an Update is available and has not happened.
      */}
      {status !== 'modified' ? null : (
        <Status
          tone="muted"
          label={text('plugins.triage.surface.views.modified', 'Modified')}
        />
      )}
    </>
  );

  const hasDetails = draft !== null
    || (namesUnavailableSources && status !== 'unsaved')
    || unreadable
    || notice !== null;
  const details = !hasDetails ? null : (
    <Stack gap="small">
      {draft === null ? null : (
        <Row gap="small" wrap align="center">
          <TextField
            label={text('plugins.triage.surface.views.name', 'View name')}
            value={draft.label}
            onChange={changeDraft}
          />
          <Button
            title={text('plugins.triage.surface.views.confirm', 'Save view')}
            variant="secondary"
            // An unnamed view is nothing typed yet, not a bound: the exact
            // label rule stays at the one CAS owner, which reports it back.
            disabled={!writable || draft.label.trim().length === 0}
            onPress={commitDraft}
          />
          <Button
            title={text('plugins.triage.surface.views.cancel', 'Cancel')}
            variant="plain"
            onPress={cancelDraft}
          />
        </Row>
      )}

      {/*
        A view is applied exactly as stored, so one naming a source the reader
        has removed legitimately matches less than it did. Saying so is what
        keeps an honestly narrow view from reading as a broken one.
      */}
      {!namesUnavailableSources || status === 'unsaved' ? null : (
        <Status
          tone="warning"
          label={text(
            'plugins.triage.surface.views.unavailableSources',
            'This view filters on sources you no longer have configured.',
          )}
        />
      )}

      {unreadable ? (
        <Status
          tone="warning"
          label={text(
            'plugins.triage.surface.views.unreadable',
            'These saved views were written by a newer version of Happier, so they were left untouched.',
          )}
        />
      ) : null}

      {/*
        An unreachable Account is said once by the page, beside the pins it
        also blocks (`shell/root.tsx`), not here a second time.
      */}
      {notice === null ? null : (
        <Status tone={notice.tone} label={notice.message} />
      )}
    </Stack>
  );
  return { control, details };
}
