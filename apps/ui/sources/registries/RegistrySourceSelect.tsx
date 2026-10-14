import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_PICKS_SOURCE_ID,
  type RegistryKindV1,
  type RegistrySourceDescriptorV1,
} from '@happier-dev/protocol/registries';

import {
  ToolbarSelect,
  type ToolbarSelectAction,
  type ToolbarSelectItem,
} from '@/components/ui/forms/ToolbarSelect';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import {
  registryFormatIcon,
  registrySourceKindLabel,
} from './registrySourcePresentation';
import { useRegistrySources } from './useRegistrySources';

export type RegistrySourceSelection = 'all' | string;

/** Happier picks lead, then built-ins, plugin sources and the sources the person added (their own order). */
export function orderRegistrySourcesForSelect(
  sources: readonly RegistrySourceDescriptorV1[],
): readonly RegistrySourceDescriptorV1[] {
  const rank = (source: RegistrySourceDescriptorV1) =>
    source.id === HAPPIER_PICKS_SOURCE_ID
      ? 0
      : source.origin.kind === 'built_in'
        ? 1
        : source.origin.kind === 'plugin'
          ? 2
          : 3;
  return [...sources]
    .filter((source) => source.enabled)
    .sort((a, b) => rank(a) - rank(b));
}

/**
 * The registry field select of every Add modal's tools row (P4 I-7): All registries, then each source that lists
 * this kind with its kind as quiet facts, then "Add a registry…" and "Manage registries" under a hairline.
 */
export function RegistrySourceSelect(
  props: Readonly<{
    kind: RegistryKindV1;
    value: RegistrySourceSelection;
    onChange: (next: RegistrySourceSelection) => void;
    onOpenRegistries: (intent: 'manage' | 'add') => void;
    testID: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const { sources } = useRegistrySources(props.kind);
  const mark = React.useCallback(
    (name: Parameters<typeof Icon>[0]['name']) => (
      <Icon
        name={name}
        size={ICON_SIZE.sm}
        color={theme.colors.text.secondary}
      />
    ),
    [theme.colors.text.secondary],
  );
  const items = React.useMemo(
    (): readonly ToolbarSelectItem[] => [
      {
        id: 'all',
        title: t('capabilities.registries.select.all'),
        icon: mark('stack'),
      },
      ...orderRegistrySourcesForSelect(sources).map((source) => ({
        id: source.id,
        title: source.title,
        icon: mark(registryFormatIcon(source)),
        detail: registrySourceKindLabel(source),
      })),
    ],
    [mark, sources],
  );
  const actions = React.useMemo(
    (): readonly ToolbarSelectAction[] => [
      {
        id: 'add',
        title: t('capabilities.registries.select.addRegistry'),
        icon: mark('plus'),
        onPress: () => props.onOpenRegistries('add'),
      },
      {
        id: 'manage',
        title: t('capabilities.registries.select.manage'),
        icon: mark('sliders-horizontal'),
        onPress: () => props.onOpenRegistries('manage'),
      },
    ],
    [mark, props.onOpenRegistries],
  );
  // A selected source that went away (removed, turned off) reads as All rather than a stale name.
  const value =
    props.value === 'all' || items.some((item) => item.id === props.value)
      ? props.value
      : 'all';
  return (
    <ToolbarSelect
      testID={props.testID}
      label={t('capabilities.registries.select.label')}
      items={items}
      selectedId={value}
      onSelect={props.onChange}
      actions={actions}
    />
  );
}
