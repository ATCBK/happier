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
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { WidgetArea } from '@/components/widgets/area/WidgetArea';
import { WidgetAreaPresetLine } from '@/components/widgets/area/WidgetAreaPresetLine';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import type { UsagePeriod } from '@/sync/api/account/usagePeriods';
import { t } from '@/text';
import type { usePublicProfileWidgetArea } from './usePublicProfileWidgetArea';

const PRESET_NAME_KEYS = {
  minimal: 'publicIdentity.editor.presetMinimal',
  dataRich: 'publicIdentity.editor.presetDataRich',
  story: 'publicIdentity.editor.presetStory',
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

/**
 * Edit on the owner's page (lab `ppcomp-E`): the one widget-area owner in place of the projected
 * blocks — start from a preset, Add, size, group and arrange, Reset/Undo — over the private Account
 * area. Nothing here is public until it is compiled at a reviewed Apply.
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
  // This page offers only its presets as named layouts; an unnamed area starts from the first one.
  const layoutId = owner?.kind === 'corePage' ? owner.layoutId : undefined;
  const selectedId = PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1.find((id) => id === layoutId) ?? PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1[0];
  const names = React.useMemo(publicProfilePresetNames, []);
  const tabs = React.useMemo(
    () =>
      PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1.map((id) => ({
        id,
        label: names[id],
      })),
    [names],
  );
  const title = t('publicIdentity.editor.blocksTitle');
  return (
    <UsageWidgetBatchProvider clauses={props.clauses}>
      <View style={styles.area} testID="public-profile-area-editor">
        <View style={styles.presets}>
          <Text variant="meta" style={styles.secondary}>
            {t('publicIdentity.editor.startFrom')}
          </Text>
          <SegmentedTabBar<PublicProfileLayoutPresetIdV1>
            tabs={tabs}
            activeTabId={selectedId}
            onSelectTab={(id) => {
              void binding.selectLayout(id);
            }}
            testIDPrefix="public-profile-area-preset"
            segmentSizing="content"
          />
        </View>
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
  presets: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s12,
  },
  secondary: { color: theme.colors.text.secondary },
}));
