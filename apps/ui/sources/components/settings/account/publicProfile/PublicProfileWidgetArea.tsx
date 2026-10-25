import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import {
  PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1,
  type PublicProfileLayoutPresetIdV1,
} from '@happier-dev/protocol/widgets/publicProfileWidgetPresetsV1';

import {
  readUsageWidgetPageContext,
  readUsageWidgetPageScope,
  readUsageWidgetQueryOverrides,
  usageWidgetSurfaceContext,
} from '@/components/settings/usage/usageWidgetPageContext';
import { UsageWidgetBatchProvider } from '@/components/settings/usage/widgets/usageWidgetBatch';
import { useWidgetAreaLayouts } from '@/components/projects/overview/useProjectDashboards';
import { WidgetArea } from '@/components/widgets/area/WidgetArea';
import {
  WidgetAreaLayoutBar,
  type WidgetAreaLayoutActions,
  type WidgetAreaLayoutLabels,
} from '@/components/widgets/area/WidgetAreaLayoutBar';
import { WidgetAreaPresetLine } from '@/components/widgets/area/WidgetAreaPresetLine';
import { Modal } from '@/modal';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import type { UsagePeriod } from '@/sync/api/account/usagePeriods';
import { t } from '@/text';
import type { usePublicProfileWidgetArea } from './usePublicProfileWidgetArea';

const PRESET_NAME_KEYS = {
  minimal: 'publicIdentity.editor.presetMinimal',
  dataRich: 'publicIdentity.editor.presetDataRich',
  story: 'publicIdentity.editor.presetStory',
  nightOwl: 'publicIdentity.editor.presetNightOwl',
} as const satisfies Record<PublicProfileLayoutPresetIdV1, string>;

export function publicProfilePresetNames(): Readonly<
  Record<PublicProfileLayoutPresetIdV1, string>
> {
  return Object.fromEntries(
    PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1.map((id) => [
      id,
      t(PRESET_NAME_KEYS[id]),
    ]),
  ) as Record<PublicProfileLayoutPresetIdV1, string>;
}

/**
 * The owner's widgets read their own Usage for the page's public period, exactly as the Usage page
 * reads it: "This page" is that period with no filters.
 */
export function usePublicProfileUsageContext(period: UsagePeriod): Readonly<{
  context: WidgetSurfaceContext;
  clauses: ReturnType<typeof readUsageWidgetQueryOverrides>;
}> {
  return React.useMemo(() => {
    const query = normalizeUsageQuery({ period: { relative: period } });
    return {
      context: usageWidgetSurfaceContext(
        readUsageWidgetPageContext(readUsageWidgetPageScope(query)),
        period,
      ),
      clauses: readUsageWidgetQueryOverrides(query),
    };
  }, [period]);
}

/** The same words every area uses for its named layouts (Usage's views, a plugin page's layouts). */
const LAYOUT_LABELS: WidgetAreaLayoutLabels = {
  get list() { return t('publicIdentity.editor.layouts'); },
  current: (name) => name,
  get create() { return t('usage.board.page.newView'); },
  get createEllipsis() { return t('usage.board.page.newView'); },
  actions: (name) => t('usage.board.page.viewActions', { name }),
  get rename() { return t('usage.board.page.renameView'); },
  moveBefore: (name) => t('usage.board.page.moveViewBefore', { name }),
  moveAfter: (name) => t('usage.board.page.moveViewAfter', { name }),
  get delete() { return t('usage.board.page.deleteView'); },
  get deleteLabel() { return t('usage.board.page.deleteView'); },
};

/**
 * Edit on the owner's page (lab `ppcomp-E`, `pplay-L`): the one widget-area owner in place of the
 * projected blocks. Its named layouts are the area's own: the presets (Minimal, Data-rich, Story,
 * Night owl) and any the owner creates, renames, reorders or deletes, through the same layout bar
 * Usage and plugin pages draw. Switching or editing a layout writes only the private Account area;
 * nothing here is public until it is compiled at a reviewed Apply.
 */
export function PublicProfileWidgetArea(
  props: Readonly<{
    widgetArea: ReturnType<typeof usePublicProfileWidgetArea>;
    clauses: ReturnType<typeof readUsageWidgetQueryOverrides>;
  }>,
): React.ReactElement {
  const { binding, area } = props.widgetArea;
  const ready = area.state.status === 'ready' ? area.state : null;
  const owner = ready?.surface.owner ?? binding.surface?.owner ?? null;
  const base = binding.surface;
  const areaSurface = React.useMemo(() => base && base.owner.kind === 'corePage'
    ? { serverId: base.serverId, accountId: base.accountId, owner: { kind: 'corePage' as const, pageId: base.owner.pageId, area: base.owner.area } }
    : null, [base?.serverId, base?.accountId]);
  const layouts = useWidgetAreaLayouts({ surface: areaSurface, execute: binding.executeLayoutAction });
  const names = React.useMemo(publicProfilePresetNames, []);
  // An unnamed area starts from the first preset, as the binding reads it.
  const selectedId = (owner?.kind === 'corePage' ? owner.layoutId : undefined) ?? PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1[0];
  const listed = layouts.state.dashboards;
  const options = React.useMemo(() => {
    const rows = listed.map((row) => ({ id: row.surface.owner.kind === 'corePage' ? row.surface.owner.layoutId ?? PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1[0] : row.artifactId,
      name: row.isPreset && row.surface.owner.kind === 'corePage' && row.surface.owner.layoutId && row.surface.owner.layoutId in names
        ? names[row.surface.owner.layoutId as PublicProfileLayoutPresetIdV1] : row.name,
      isPreset: row.isPreset, edited: row.isEdited, summary: row }));
    // Held while the inventory loads: the presets are known, so the bar never appears late.
    return rows.length ? rows : PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1.map((id) => ({ id, name: names[id], isPreset: true, edited: false, summary: null }));
  }, [listed, names]);
  const selectLayout = binding.selectLayout;
  const create = React.useCallback(async () => {
    const source = ready?.surface;
    const name = (await Modal.prompt(t('usage.board.page.newViewTitle'), t('publicIdentity.editor.newLayoutBody'),
      { placeholder: t('usage.board.page.newViewPlaceholder'), confirmText: t('common.create') }))?.trim();
    if (!name || !source) return;
    const created = await layouts.create(name, source);
    const layoutId = created.ok && created.dashboard?.surface.owner.kind === 'corePage' ? created.dashboard.surface.owner.layoutId : undefined;
    if (layoutId) await selectLayout(layoutId);
  }, [layouts, ready?.surface, selectLayout]);
  const selected = options.find((option) => option.id === selectedId) ?? null;
  const actions = React.useMemo((): WidgetAreaLayoutActions | null => {
    const summary = selected?.summary;
    if (!summary || !ready?.canEdit) return null;
    const index = options.findIndex((option) => option.id === selected.id);
    const before = options[index - 1]?.summary;
    const after = options[index + 1]?.summary;
    return {
      rename: async () => {
        const name = (await Modal.prompt(t('usage.board.page.renameViewTitle'), undefined,
          { defaultValue: selected.name, confirmText: t('common.save') }))?.trim();
        if (name && name !== selected.name) await layouts.rename(summary, name);
      },
      ...(before ? { moveBefore: { name: options[index - 1]!.name, onPress: () => { void layouts.reorder(summary, { anchorId: before.artifactId, placement: 'before' }); } } } : {}),
      ...(after ? { moveAfter: { name: options[index + 1]!.name, onPress: () => { void layouts.reorder(summary, { anchorId: after.artifactId, placement: 'after' }); } } } : {}),
      // A preset is the page's own stock composition: it resets rather than going away.
      delete: summary.isPreset ? { disabledReason: t('projects.dashboard.defaultProtected') } : { onPress: async () => {
        const removed = await layouts.remove(summary);
        if (removed.ok && !removed.approvalPending) await selectLayout(PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1[0]);
      } },
    };
  }, [layouts, options, ready?.canEdit, selected, selectLayout]);
  const title = selected?.name ?? t('publicIdentity.editor.blocksTitle');
  return (
    <UsageWidgetBatchProvider clauses={props.clauses}>
      <View style={styles.area} testID="public-profile-area-editor">
        <WidgetAreaLayoutBar
          layouts={options}
          selectedId={selectedId}
          onSelect={(id) => { void selectLayout(id); }}
          onCreate={ready?.canEdit ? () => { void create(); } : null}
          actions={actions}
          labels={LAYOUT_LABELS}
          heading="section"
          testID="public-profile-area-layouts"
        />
        {ready?.preset?.isEdited ? (
          <WidgetAreaPresetLine
            preset={ready.preset}
            surface={ready.surface}
            presetActions={binding}
            testID="public-profile-area.preset"
          />
        ) : null}
        <WidgetArea
          port={binding.port}
          context={binding.context}
          layout={area}
          geometry="grid"
          title={title}
          surfaceName={title}
          dashboard={{
            addLabel: t('publicIdentity.editor.addBlock'),
            emptyTitle: t('publicIdentity.page.empty'),
            addTitle: t('publicIdentity.editor.addBlockTitle'),
          }}
          testID="public-profile-area"
        />
      </View>
    </UsageWidgetBatchProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  area: { gap: theme.space.s12 },
}));
