import * as React from 'react';

import { Button } from './Button.js';
import { TextField } from './Form.js';
import { Row, Stack } from './Layout.js';
import { Dropdown, type MenuItem } from './Overlay.js';
import { Status } from './Status.js';

/** Admitted display identity; the caller retains the saved filter and its storage. */
export type CollectionSavedViewItem = Readonly<{ id: string; label: string }>;

export type CollectionSavedViewsLabels = Readonly<{
  title: string;
  /** Omit when the collection always selects a saved/default item. */
  unselected?: string;
  actions: string;
  create: string;
  rename: string;
  update: string;
  delete: string;
  modified: string;
  name: string;
  confirm: string;
  cancel: string;
}>;

export type CollectionSavedViewsControlProps<T extends CollectionSavedViewItem> = Readonly<{
  /** Stable captured Account authority key, or its bound host facade. */
  scope: string | object;
  items: readonly T[];
  selectedId: string | null;
  modified: boolean;
  labels: CollectionSavedViewsLabels;
  disabled?: boolean;
  busy?: boolean;
  /** Domain-owned notices follow the naming row in the same details stack. */
  notices?: React.ReactNode;
  onSelect: (id: string | null) => void;
  /** Resolve true only when the caller's authoritative mutation accepted the name. */
  onCreate: (label: string) => Promise<boolean>;
  onRename: (item: T, label: string) => Promise<boolean>;
  onUpdate: (item: T) => void;
  onDelete: (item: T) => void;
}>;

type NameDraft =
  | Readonly<{ kind: 'create'; label: string }>
  | Readonly<{ kind: 'rename'; id: string; label: string }>;

type ControlState = Readonly<{
  scope: CollectionSavedViewsControlProps<CollectionSavedViewItem>['scope'];
  draft: NameDraft | null;
  open: boolean;
}>;

const VIEW_ITEM_PREFIX = 'view:';
const VIEWS_RADIO_GROUP = 'views';
const OPERATION_CREATE = 'operation:create';
const OPERATION_RENAME = 'operation:rename';
const OPERATION_UPDATE = 'operation:update';
const OPERATION_DELETE = 'operation:delete';

/**
 * Controlled saved-view picker and naming presentation for CollectionToolbar.lens.
 * The caller owns selection, filter comparison, mutation acceptance and notices;
 * Dropdown retains menu focus/dismissal. Only the temporary name draft lives here.
 * The captured scope keys local presentation state, withdrawing private drafts
 * and an open menu before another Account's items or callbacks can be displayed.
 */
export function useCollectionSavedViewsControl<T extends CollectionSavedViewItem>(
  props: CollectionSavedViewsControlProps<T>,
): Readonly<{ control: React.ReactElement; details: React.ReactElement | null }> {
  const { scope, items, selectedId, modified, labels, disabled, busy, notices,
    onSelect, onCreate, onRename, onUpdate, onDelete } = props;
  const [state, setState] = React.useState<ControlState>(() => ({ scope, draft: null, open: false }));
  // As with PluginUiProvider's bound-host state, retire during render so an old
  // Account's private name is never painted for the next authority, even once.
  if (state.scope !== scope) setState({ scope, draft: null, open: false });
  const { draft, open } = state;
  const setDraft = React.useCallback((next: React.SetStateAction<NameDraft | null>) => {
    setState((current) => current.scope !== scope ? current : {
      ...current, draft: typeof next === 'function' ? next(current.draft) : next,
    });
  }, [scope]);
  const setOpen = React.useCallback((next: boolean) => {
    setState((current) => current.scope !== scope ? current : { ...current, open: next });
  }, [scope]);
  const selected = React.useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);
  const writable = !disabled && !busy;
  const cancelDraft = React.useCallback(() => { setDraft(null); }, [setDraft]);
  const changeDraft = React.useCallback((label: string) => {
    setDraft((current) => current === null ? current : { ...current, label });
  }, [setDraft]);
  const commitDraft = React.useCallback(async () => {
    if (draft === null || busy) return;
    // A rename receives the latest admitted item, preserving a concurrent lens edit.
    const target = draft.kind === 'rename' ? items.find((item) => item.id === draft.id) : undefined;
    const applied = draft.kind === 'create'
      ? await onCreate(draft.label)
      : target !== undefined && await onRename(target, draft.label);
    // Editing or cancelling during settlement is a newer intent.
    if (applied) setDraft((current) => current === draft ? null : current);
  }, [busy, draft, items, onCreate, onRename, setDraft]);

  const menuItems = React.useMemo((): MenuItem[] => [
    ...(labels.unselected === undefined ? [] : [{
      id: VIEW_ITEM_PREFIX, label: labels.unselected, kind: 'radio' as const,
      radioGroupId: VIEWS_RADIO_GROUP, disabled: !writable,
    }]),
    ...items.map((item): MenuItem => ({
      id: VIEW_ITEM_PREFIX + item.id, label: item.label, kind: 'radio',
      radioGroupId: VIEWS_RADIO_GROUP, disabled: !writable,
    })),
  ], [items, labels.unselected, writable]);
  const operations = React.useMemo((): MenuItem[] => [
    { id: OPERATION_CREATE, label: labels.create, disabled: !writable || draft !== null },
    ...(selected === null ? [] : [
      { id: OPERATION_RENAME, label: labels.rename, disabled: !writable || draft !== null },
      { id: OPERATION_UPDATE, label: labels.update, disabled: !writable || !modified },
      { id: OPERATION_DELETE, label: labels.delete, disabled: !writable },
    ]),
  ], [draft, labels, modified, selected, writable]);
  const onSelectItem = React.useCallback((id: string) => {
    if (id.startsWith(VIEW_ITEM_PREFIX)) {
      setDraft(null);
      onSelect(id.slice(VIEW_ITEM_PREFIX.length) || null);
    } else if (id === OPERATION_CREATE) {
      setDraft({ kind: 'create', label: '' });
    } else if (selected !== null) {
      if (id === OPERATION_RENAME) setDraft({ kind: 'rename', id: selected.id, label: selected.label });
      else if (id === OPERATION_UPDATE) onUpdate(selected);
      else if (id === OPERATION_DELETE) onDelete(selected);
    }
  }, [onDelete, onSelect, onUpdate, selected, setDraft]);
  const currentLabel = selected?.label ?? labels.unselected ?? labels.title;
  const control = <>
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={selected?.label ?? labels.title}
      triggerAppearance="text"
      triggerDisclosure
      triggerAccessibilityLabel={`${labels.title}: ${currentLabel}`}
      radioGroups={[{ id: VIEWS_RADIO_GROUP, accessibilityLabel: labels.title, selectedId: VIEW_ITEM_PREFIX + (selectedId ?? '') }]}
      items={menuItems}
      groups={[{ id: 'operations', accessibilityLabel: labels.actions, items: operations }]}
      onSelect={onSelectItem}
    />
    {!modified ? null : <Status tone="muted" label={labels.modified} />}
  </>;
  const details = draft === null && notices == null ? null : <Stack gap="small">
    {draft === null ? null : <Row gap="small" wrap align="center">
      <TextField label={labels.name} value={draft.label} onChange={changeDraft} />
      <Button title={labels.confirm} variant="secondary" disabled={!writable || draft.label.trim().length === 0} onPress={commitDraft} />
      <Button title={labels.cancel} variant="plain" onPress={cancelDraft} />
    </Row>}
    {notices}
  </Stack>;
  return { control, details };
}
