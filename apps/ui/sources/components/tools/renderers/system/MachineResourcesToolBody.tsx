import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Collection, useHappierCollection } from '@happier-dev/plugin-ui';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useProcessesCollectionAnatomy } from '@/components/machines/processes/processesCollectionAnatomy';
import { useProcessOwnerTitles } from '@/components/machines/processes/processOwnerIdentity';
import {
  buildMachineProcessesView,
  type ProcessesItem,
  type ProcessesSort,
} from '@/components/machines/processes/processesPresentation';
import type { TranscriptMachineResourcesCall } from '@/components/sessions/transcript/references/transcriptMachineResourcesReference';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { ToolSectionView } from '../../shell/presentation/ToolSectionView';

const BY_MEMORY: ProcessesSort = { key: 'memory', direction: 'descending' };
const keyOf = (item: ProcessesItem) => item.key;
/** The Processes tab's own table minimum (same rows, same columns). */
const TABLE_MIN_WIDTH_PX = 520;
/** Analysing reserves the rows the card will have; the frame never changes width (lab `ra` A7·1). */
const RESERVED_ROWS = 2;

/**
 * A machine-resources tool call's body (plan 60 AGW-9 / A7): a completed process census renders the
 * Processes tab's own rows, read-only (no actions, no sparklines); a set Action still being proposed
 * renders the proposal card frame with its rows reserved and no approval.
 */
export const MachineResourcesToolBody = React.memo(
  function MachineResourcesToolBody(
    props: Readonly<{
      call: TranscriptMachineResourcesCall;
      serverId?: string | null;
    }>,
  ) {
    if (props.call.kind === 'processes')
      return (
        <ProcessesTree call={props.call} serverId={props.serverId ?? null} />
      );
    return <ProposalAnalysing call={props.call} />;
  },
);

function ProcessesTree(
  props: Readonly<{
    call: Extract<TranscriptMachineResourcesCall, { kind: 'processes' }>;
    serverId: string | null;
  }>,
) {
  const compact = useDeviceType() === 'phone';
  const serverId = props.call.serverId ?? props.serverId ?? '';
  const titles = useProcessOwnerTitles(props.call.answer.owners, serverId);
  const items = React.useMemo(
    () =>
      buildMachineProcessesView({
        answer: props.call.answer,
        scope: 'happier',
        sort: BY_MEMORY,
        ownerTitle: (owner) => titles.get(owner.rowId) ?? null,
      }).items,
    [props.call.answer, titles],
  );
  const model = useHappierCollection<ProcessesItem>({
    items,
    keyOf,
    openKey: null,
    onOpenChange: noop,
    expandable: true,
  });
  const anatomyInput = React.useMemo(
    () => ({
      serverId,
      machineId: props.call.machineId,
      machineName: '',
      titles,
      cpuCapacityCores: null,
      compact,
      readOnly: true,
    }),
    [compact, props.call.machineId, serverId, titles],
  );
  const anatomy = useProcessesCollectionAnatomy(anatomyInput);
  if (items.length === 0) return null;
  return (
    <ToolSectionView fullWidth>
      <View testID="machine-resources-tool-processes">
        <CoreCollectionScope>
          <Collection<ProcessesItem>
            testID="machine-resources-tool-processes-tree"
            model={model}
            anatomy={anatomy}
            accessibilityLabel={t('resourceProposal.processesTree')}
            presentation={compact ? 'list' : 'table'}
            detail="none"
            scroll="page"
            minListWidth={TABLE_MIN_WIDTH_PX}
            minDetailWidth={TABLE_MIN_WIDTH_PX}
            preferredListRatio={1}
          />
        </CoreCollectionScope>
      </View>
    </ToolSectionView>
  );
}

function noop(): void {}

function ProposalAnalysing(
  props: Readonly<{
    call: Extract<TranscriptMachineResourcesCall, { kind: 'proposing' }>;
  }>,
) {
  const { theme } = useUnistyles();
  const items = props.call.proposal?.items ?? [];
  const reserved =
    Math.max(0, RESERVED_ROWS - items.length) +
    (items.length > 0 ? 1 : RESERVED_ROWS);
  const title =
    props.call.actionId !== 'machines.storage.trash.move' && props.call.actionId !== 'machines.storage.deleteNow'
      ? t('resourceProposal.title.processes')
      : t('resourceProposal.title.storage');
  return (
    <ToolSectionView fullWidth>
      <View
        testID="machine-resources-tool-analysing"
        style={styles.frame}
        accessibilityState={{ busy: true }}
      >
        <Text style={styles.title}>{title}</Text>
        {items.map((item) => (
          <View key={item.key} style={styles.row}>
            <Text style={styles.rowText} numberOfLines={1}>
              {item.path}
            </Text>
          </View>
        ))}
        {Array.from({ length: reserved }, (_, index) => (
          <View key={`reserved-${index}`} style={styles.row}>
            <View
              style={[
                styles.skeleton,
                { backgroundColor: theme.colors.surface.skeleton },
              ]}
            />
          </View>
        ))}
        <View style={styles.foot}>
          <ActivitySpinner size="small" color={theme.colors.text.secondary} />
          <View style={styles.footCopy}>
            <Text style={styles.footTitle}>
              {t('resourceProposal.analysingFound', { count: items.length })}
            </Text>
            <Text style={styles.footNote}>
              {t('resourceProposal.analysingNote')}
            </Text>
          </View>
        </View>
      </View>
    </ToolSectionView>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.surface,
    overflow: 'hidden',
  },
  title: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s8,
  },
  row: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.space.s16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  rowText: {
    ...Typography.mono(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  skeleton: {
    height: 10,
    width: '55%',
    borderRadius: 5,
  },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  footCopy: {
    flex: 1,
    gap: theme.space.s2,
  },
  footTitle: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.primary,
  },
  footNote: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
}));
