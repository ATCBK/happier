import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type {
  MachineStorageSuggestionsListInputV1,
  StorageItemV1,
} from '@happier-dev/protocol/storage/storageV1';

import { useMachineTabCompactLayout } from '@/components/machines/page/useMachineTabCompactLayout';
import { useMachineTabFacts } from '@/components/machines/page/useMachineTabFacts';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineStorageItems } from '@/sync/domains/machines/storage/useMachineStorageItems';
import { useMachineStorageSummary } from '@/sync/domains/machines/storage/useMachineStorageSummary';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

import { StorageHint, StoragePageHead, StorageSayLine } from './StoragePageHead';
import {
  useStorageCollect,
  type StorageCollectController,
} from './StorageCollectToggle';
import { StorageItemRow } from './StorageItemRow';
import { StoragePileDock } from './StoragePileDock';
import { describeStorageVerdict, storageEvidenceLabel } from './storageReasonPresentation';
import { StorageVolumeRow } from './StorageVolumes';
import { selectStorageHeadlineVolume } from './storageViewModel';

type Group = NonNullable<MachineStorageSuggestionsListInputV1['group']>;
const GROUPS: readonly Group[] = [
  'can-be-rebuilt',
  'old-and-unused',
  'outside-happier',
];
const GROUP_KEYS = {
  'can-be-rebuilt': 'rebuilt',
  'old-and-unused': 'unused',
  'outside-happier': 'outside',
} as const;

/**
 * Suggestions (plan 40 STO-9, lab `rs` S / Sp): only what the machine has verified, grouped Can be
 * rebuilt · Old and unused · Outside Happier (the last only after a whole-disk scan), each with its
 * evidence, size and verdict. Ticking collects; "Collect all" takes a group's Safe and Caution items.
 */
export const StorageSuggestionsPage = React.memo(
  function StorageSuggestionsPage(
    props: Readonly<{
      serverId: string;
      machineId: string;
      machineName: string;
      onBack: () => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const layout = useMachineTabCompactLayout();
    const target = { machineId: props.machineId, serverId: props.serverId };
    const summary = useMachineStorageSummary(target);
    const collect = useStorageCollect({ ...target, readOnly: summary.offline });
    const { homeDir } = useMachineTabFacts(props.serverId, props.machineId);
    const rebuilt = useMachineStorageItems({
      ...target,
      list: 'suggestions',
      group: 'can-be-rebuilt',
    });
    const unused = useMachineStorageItems({
      ...target,
      list: 'suggestions',
      group: 'old-and-unused',
    });
    const outside = useMachineStorageItems({
      ...target,
      list: 'suggestions',
      group: 'outside-happier',
    });
    const lists = {
      'can-be-rebuilt': rebuilt,
      'old-and-unused': unused,
      'outside-happier': outside,
    };
    const all = GROUPS.flatMap((group) => lists[group].page?.items ?? []);
    const total = all.reduce((sum, item) => sum + item.size.freesBytes, 0);
    const largest = all.reduce(
      (max, item) => Math.max(max, item.size.allocatedBytes),
      0,
    );
    const ready = GROUPS.every((group) => lists[group].page !== null);
    const headline = summary.summary
      ? selectStorageHeadlineVolume(summary.summary)
      : null;
    return (
      <View testID="machine-storage-suggestions" onLayout={layout.onLayout}>
        <StoragePageHead title={t('machineStorage.suggestions.title')} onBack={props.onBack}>
          {ready ? (
            <StorageSayLine
              lead={t('machineStorage.suggestions.lead', { amount: formatMachineBytes(total, 'storage') })}
              text={t('machineStorage.suggestions.about', { count: all.length })}
            />
          ) : null}
        </StoragePageHead>
        {headline ? (
          <ItemGroup header="none">
            <StorageVolumeRow volume={headline} compact={layout.compact} />
          </ItemGroup>
        ) : null}
        {GROUPS.every((group) => !lists[group].page && lists[group].offline) ? (
          // Offline wins over a failed or unreported read: the machine is away, nothing to retry yet.
          <ItemGroup>
            <SurfaceStateCard
              testID="machine-storage-suggestions-offline"
              kind="unavailable"
              size="line"
              title={t('machineStorage.states.offlineTitle', { machine: props.machineName })}
              reason={t('machineStorage.states.offlineReason')}
            />
          </ItemGroup>
        ) : !ready && GROUPS.every((group) => lists[group].status !== 'error' && !lists[group].offline) ? (
          <ItemGroup>
            <SurfaceStateCard
              kind="loading"
              size="line"
              title={t('machineStorage.page.loading')}
            />
          </ItemGroup>
        ) : ready && all.length === 0 ? (
          <ItemGroup>
            <SurfaceStateCard
              testID="machine-storage-suggestions-empty"
              kind="empty"
              size="line"
              title={t('machineStorage.suggestions.none')}
            />
          </ItemGroup>
        ) : (
          GROUPS.map((group) => {
            const state = lists[group];
            // An offline group without an answer says nothing of its own: the page's offline line covers it.
            if (!state.page && state.offline) return null;
            if (state.status === 'error' && !state.page) {
              return (
                <ItemGroup key={group}>
                  <SurfaceStateCard
                    kind="error"
                    size="line"
                    title={t('machineStorage.page.error')}
                    action={{
                      label: t('machineStorage.tryAgain'),
                      onPress: state.retry,
                    }}
                  />
                </ItemGroup>
              );
            }
            const items = state.page?.items ?? [];
            if (items.length === 0) return null;
            return (
              <SuggestionGroup
                key={group}
                group={group}
                items={items}
                largest={largest}
                collect={collect}
                compact={layout.compact}
                homeDir={homeDir}
              />
            );
          })
        )}
        <StorageHint icon="shield-check" text={t('machineStorage.suggestions.hint', { machine: props.machineName })} />
        {summary.summary ? (
          <StoragePileDock
            serverId={props.serverId}
            machineId={props.machineId}
            machineName={props.machineName}
            summary={summary.summary}
            compact={layout.compact}
            readOnly={summary.offline}
          />
        ) : null}
      </View>
    );
  },
);

function describeSuggestionEvidence(
  item: StorageItemV1,
  homeDir: string | undefined,
): string {
  return (
    item.evidence.length > 0
      ? item.evidence.map(storageEvidenceLabel)
      : [formatPathRelativeToHome(item.path, homeDir)]
  ).join(' · ');
}

const SuggestionGroup = React.memo(function SuggestionGroup(
  props: Readonly<{
    group: Group;
    items: readonly StorageItemV1[];
    largest: number;
    collect: StorageCollectController;
    compact: boolean;
    homeDir: string | undefined;
  }>,
) {
  const { collect } = props;
  const sweep = props.items.filter(
    (item) => collect.stateOf(item) === 'available',
  ).length;
  const bytes = props.items.reduce(
    (sum, item) => sum + item.size.freesBytes,
    0,
  );
  const key = GROUP_KEYS[props.group];
  return (
    <ItemGroup
      title={t(`machineStorage.suggestions.groups.${key}`)}
      titleAccessory={
        <Text style={styles.meta}>
          {props.group === 'outside-happier'
            ? t('machineStorage.suggestions.fromScan')
            : t('machineStorage.suggestions.groupMeta', {
                count: props.items.length,
                size: formatMachineBytes(bytes, 'storage'),
              })}
        </Text>
      }
      action={
        !props.compact && sweep > 0 ? (
          <TextLinkButton
            tone="strong"
            testID={`machine-storage-suggestions-${key}-all`}
            label={t('machineStorage.suggestions.collectAll', { count: sweep })}
            onPress={() => collect.collectAll(props.items)}
          />
        ) : undefined
      }
    >
      {props.items.map((item, index) => (
        <StorageItemRow
          key={item.itemId}
          testID={`machine-storage-suggestion-${item.itemId}`}
          title={item.title}
          evidence={describeSuggestionEvidence(item, props.homeDir)}
          bytes={item.size.allocatedBytes}
          atLeast={item.size.atLeast}
          largest={props.largest}
          freesBytes={item.size.freesBytes}
          chip={describeStorageVerdict(item)}
          compact={props.compact}
          collect={collect.rowProps(item, props.items)}
          showDivider={index < props.items.length - 1}
        />
      ))}
    </ItemGroup>
  );
});

const styles = StyleSheet.create((theme) => ({
  meta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
}));
