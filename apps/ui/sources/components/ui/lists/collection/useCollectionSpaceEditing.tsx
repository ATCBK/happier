import * as React from 'react';
import type { View } from 'react-native';
import {
  getDefaultCollectionSpaceIdV1,
  type CollectionEntityKindV1,
  type CollectionSpaceIconV1,
  type CollectionSpaceMutationV1,
  type CollectionSpaceV1,
} from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import type { CollectionFilterMapV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import {
  MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
  Popover,
} from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { collectionSpaceSettingRefs } from '@/components/settings/session/collectionSpaceSettings';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

import {
  CollectionSpaceForm,
  type CollectionSpaceFormValue,
} from './CollectionSpaceForm';

const FORM_POPOVER_WIDTH_PX = 340;

type SpaceForm = Readonly<{
  mode: 'create' | 'edit';
  error: string | null;
  busy: boolean;
}>;

/**
 * One owner for a saved-space list's space writes (lab `clfilter:save`), whatever it lists: the
 * `settings.invoke` `<entity>.list.spaces` intent (create, edit, delete, reset, reorder), the selected-space
 * setting, and the save/edit form hanging from the list's header. Sessions, Workflows and Discussions bind
 * it with their own filter and summary; nothing here knows what a filter means.
 */
export function useCollectionSpaceEditing<K extends CollectionEntityKindV1>(
  input: Readonly<{
    entityKind: K;
    testIDPrefix: string;
    serverId: string | null;
    spaces: readonly CollectionSpaceV1<K>[];
    selectedSpace: CollectionSpaceV1<K> | null;
    /** The stored shape of what the list shows now (the space plus its transient conditions). */
    currentFilter: CollectionFilterMapV1[K];
    /** A new space's prefill, from the conditions on screen. */
    suggestion: Readonly<{ name: string; icon: CollectionSpaceIconV1 }>;
    /** What the space keeps, one short phrase per condition. */
    summary: readonly string[];
    /** Whether the list offers "Include needs-you from everywhere" (Sessions). */
    everywhereChoice?: boolean;
    anchorRef: React.RefObject<View | null>;
    /** Called before the form opens (the condition editor closes, so one surface hangs at a time). */
    onWillOpenForm?: () => void;
  }>,
) {
  const { entityKind, selectedSpace, currentFilter } = input;
  const refs = React.useMemo(
    () => collectionSpaceSettingRefs(entityKind),
    [entityKind],
  );
  const defaultSpaceId = getDefaultCollectionSpaceIdV1(entityKind);
  const actions = useMountedActionExecution(input.serverId);
  const { setSetting } = useSettingActionFeedback({
    serverId: input.serverId ?? undefined,
  });
  const [form, setForm] = React.useState<SpaceForm | null>(null);

  const invoke = React.useCallback(
    async (mutation: CollectionSpaceMutationV1<K>): Promise<boolean> => {
      try {
        const result = await actions.execute('settings.invoke', {
          anchor: refs.spaces.anchor,
          input: { kind: 'collection_space', entityKind, mutation },
        });
        const status = result.ok
          ? (result.result as { status?: unknown } | null)?.status
          : undefined;
        return status === 'completed';
      } catch {
        return false;
      }
    },
    [actions, entityKind, refs.spaces.anchor],
  );

  const selectSpace = React.useCallback(
    (spaceId: string): Promise<boolean> =>
      setSetting({ anchor: refs.selectedSpace.anchor }, { spaceId }),
    [refs.selectedSpace.anchor, setSetting],
  );

  const onWillOpenForm = input.onWillOpenForm;
  const openSaveAs = React.useCallback(() => {
    onWillOpenForm?.();
    setForm({ mode: 'create', error: null, busy: false });
  }, [onWillOpenForm]);
  const openEdit = React.useCallback(() => {
    onWillOpenForm?.();
    setForm({ mode: 'edit', error: null, busy: false });
  }, [onWillOpenForm]);
  const closeForm = React.useCallback(() => setForm(null), []);
  const saveChanges = React.useCallback(() => {
    if (!selectedSpace) return;
    void invoke({
      op: 'edit',
      spaceId: selectedSpace.id,
      changes: { filter: currentFilter },
    });
  }, [currentFilter, invoke, selectedSpace]);
  const submitForm = React.useCallback(
    async (value: CollectionSpaceFormValue) => {
      if (!form) return;
      setForm({ ...form, busy: true, error: null });
      const accepted =
        form.mode === 'create'
          ? await invoke({
              op: 'create',
              space: {
                entityKind,
                id: randomUUID(),
                ...value,
                filter: currentFilter,
              },
            })
          : selectedSpace
            ? await invoke({
                op: 'edit',
                spaceId: selectedSpace.id,
                changes: { ...value, filter: currentFilter },
              })
            : false;
      setForm((current) =>
        current === null
          ? null
          : accepted
            ? null
            : {
                ...current,
                busy: false,
                error: t('sessionsList.spacesSaveFailed'),
              },
      );
    },
    [currentFilter, entityKind, form, invoke, selectedSpace],
  );
  const deleteSelected = React.useCallback(async () => {
    if (!selectedSpace) return;
    if (selectedSpace.id === defaultSpaceId) {
      if (await invoke({ op: 'resetDefault' })) setForm(null);
      return;
    }
    const confirmed = await Modal.confirm(
      t('sessionsList.spacesDeleteTitle', { name: selectedSpace.name }),
      t('sessionsList.spacesDeleteBody'),
      { confirmText: t('sessionsList.spacesDelete'), destructive: true },
    );
    if (
      confirmed &&
      (await invoke({ op: 'delete', spaceId: selectedSpace.id }))
    )
      setForm(null);
  }, [defaultSpaceId, invoke, selectedSpace]);
  /** Moves a space before another (null: to the end); the strip, menu, swipes and digits follow the order. */
  const reorder = React.useCallback(
    (spaceId: string, beforeSpaceId: string | null) =>
      invoke({ op: 'reorder', spaceId, beforeSpaceId }),
    [invoke],
  );

  const formNode =
    form === null ? null : (
      <CollectionSpaceForm
        key={`${form.mode}:${selectedSpace?.id ?? ''}`}
        testIDPrefix={input.testIDPrefix}
        mode={form.mode}
        everywhereChoice={input.everywhereChoice}
        initial={
          form.mode === 'edit' && selectedSpace
            ? {
                name: selectedSpace.name,
                icon: selectedSpace.icon,
                includeNeedsYouEverywhere:
                  selectedSpace.includeNeedsYouEverywhere,
              }
            : { ...input.suggestion, includeNeedsYouEverywhere: false }
        }
        suggestedIcons={[input.suggestion.icon]}
        summary={input.summary}
        busy={form.busy}
        error={form.error}
        deletion={
          form.mode === 'edit'
            ? selectedSpace?.id === defaultSpaceId
              ? 'reset'
              : 'delete'
            : undefined
        }
        onSubmit={(value) => {
          void submitForm(value);
        }}
        onCancel={closeForm}
        onDelete={() => {
          void deleteSelected();
        }}
      />
    );
  const formMode = form?.mode;
  const anchorRef = input.anchorRef;
  const formOverlay = React.useMemo(
    () => (
      <Popover
        open={formMode !== undefined}
        anchorRef={anchorRef}
        placement="bottom"
        gap={6}
        boundaryRef={null}
        edgePadding={{ horizontal: 8, vertical: 8 }}
        maxWidthCap={FORM_POPOVER_WIDTH_PX}
        autoFocusOnOpen
        portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
        onRequestClose={closeForm}
        backdrop={false}
        phonePresentation="sheet"
        accessibilityLabel={
          formMode === 'edit'
            ? t('sessionsList.spacesEdit')
            : t('sessionsList.spacesSaveAs')
        }
        containerStyle={{ paddingHorizontal: 0 }}
      >
        {({ maxHeight }) => (
          <FloatingOverlay
            maxHeight={maxHeight}
            surfaceChrome="theme"
            scrollEnabled={false}
          >
            {formNode}
          </FloatingOverlay>
        )}
      </Popover>
    ),
    [anchorRef, closeForm, formMode, formNode],
  );

  return {
    invoke,
    selectSpace,
    reorder,
    openSaveAs,
    openEdit,
    saveChanges,
    formOverlay,
  };
}
