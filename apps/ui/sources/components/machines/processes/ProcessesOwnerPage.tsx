import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useMachinePageState } from '@/components/machines/page/machinePageContext';
import type {
  MachinePageTabBodyProps,
  MachinePageTabParams,
} from '@/components/machines/page/machinePageTabQuery';
import { readMachinePublishedResources } from '@/components/machines/summary/machineResourceSentences';
import { formatVitalsPercent } from '@/components/machines/vitals/vitalsFormat';
import { VitalsMeterRow } from '@/components/machines/vitals/VitalsMeterRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineProcesses } from '@/sync/domains/machines/processes/useMachineProcesses';
import { t } from '@/text';

import { ProcessDetail } from './ProcessDetail';
import { ProcessesStateCard } from './ProcessesStateCard';
import {
  formatProcessCpu,
  formatProcessMemory,
  ProcessOwnershipPill,
} from './processesCollectionAnatomy';
import {
  describeProcessTitle,
  ProcessOwnerMark,
  useProcessOwnerStatus,
  useProcessOwnerTitles,
} from './processOwnerIdentity';
import {
  buildMachineProcessesView,
  type ProcessesOwnerItem,
} from './processesPresentation';
import { useProcessesController } from './useProcessesController';

type ProcessesParams = Extract<MachinePageTabParams, { id: 'processes' }>;

/**
 * Phone (lab `rp` Dp): a row pushes its owner — identity, its two meters, its processes, then the actions as
 * a quiet button row with the destructive one last and one sentence of consequence — and a process pushes
 * its detail. The same watch and the same Actions as the tree.
 */
export function ProcessesOwnerPage(
  props: Omit<MachinePageTabBodyProps, 'params'> &
    Readonly<{ params: ProcessesParams }>,
) {
  const { serverId, machineId, machineName, online, setParams, params } = props;
  const { target } = useMachinePageState();
  const daemonState: unknown = target.machine?.daemonState;
  const published = React.useMemo(
    () => readMachinePublishedResources(daemonState),
    [daemonState],
  );
  const processes = useMachineProcesses({
    serverId,
    machineId,
    scope: 'happier',
    view: 'tree',
    online,
    ...(params.page === 'process' && params.process
      ? { detailToken: params.process }
      : {}),
  });
  const answer = processes.answer?.state === 'live' ? processes.answer : null;
  const titles = useProcessOwnerTitles(answer?.owners, serverId);
  const binding = processes.accountBinding;
  const isCurrent = React.useCallback(
    () => Boolean(binding?.isCurrent()),
    [binding],
  );
  const back = React.useCallback(() => {
    setParams(
      params.page === 'process' && params.owner
        ? { id: 'processes', page: 'owner', owner: params.owner }
        : { id: 'processes' },
    );
  }, [params.owner, params.page, setParams]);
  const controller = useProcessesController({
    serverId,
    machineId,
    machineName,
    answer,
    titles,
    expectedAccountId: binding?.accountId ?? null,
    isCurrent,
    unavailableReason: online
      ? null
      : t('machineProcesses.states.offlineTitle', { machine: machineName }),
    focusAfter: () => {},
  });
  const view = React.useMemo(
    () =>
      answer
        ? buildMachineProcessesView({
            answer,
            scope: 'happier',
            sort: { key: params.sort ?? 'memory', direction: 'descending' },
          })
        : null,
    [answer, params.sort],
  );

  const backLink = (
    <TextLinkButton
      testID="machine-processes-back"
      label={t('machineProcesses.phone.back')}
      tone="strong"
      onPress={back}
    />
  );
  if (!answer || !view)
    return (
      <View style={styles.page}>
        {backLink}
        <ProcessesStateCard status={processes.status} reason={processes.reason}
          online={online} machineName={machineName} onRetry={processes.retry} />
      </View>
    );

  if (params.page === 'process') {
    const process = answer.owners
      .flatMap((owner) => owner.members.map((row) => ({ row, owner })))
      .find((entry) => entry.row.ref === params.process);
    const left = answer.leftBehind.find((row) => row.ref === params.process);
    const row = process?.row ?? left;
    if (!row)
      return (
        <View style={styles.page}>
          {backLink}
          <SurfaceStateCard
            kind="empty"
            title={t('machineProcesses.kill.recheckedGone')}
          />
        </View>
      );
    return (
      <View style={styles.page} testID="machine-processes-process-page">
        {backLink}
        <Text style={styles.title}>{describeProcessTitle(row)}</Text>
        <ProcessDetail
          row={row}
          owner={process?.owner.owner ?? left?.owner ?? null}
          ownerTitle={
            process ? (titles.get(process.owner.rowId) ?? null) : null
          }
          machineName={machineName}
          platform={answer.platform}
          homeDir={target.machine?.metadata?.homeDir}
          samples={answer.history?.[row.ref]}
          ceiling={process?.owner.ceiling}
          onCopyCommand={row.level === 'proven' ? controller.copy : null}
          onOpenSession={controller.openSession}
        />
      </View>
    );
  }

  const owner = view.items.find(
    (item): item is ProcessesOwnerItem =>
      item.kind === 'owner' && item.owner.rowId === params.owner,
  );
  if (!owner)
    return (
      <View style={styles.page}>
        {backLink}
        <SurfaceStateCard
          kind="empty"
          title={t('machineProcesses.kill.recheckedGone')}
        />
      </View>
    );
  const members = view.items.filter(
    (item) => item.kind === 'process' && item.ownerKey === owner.key,
  );
  const memoryTotal = published?.host?.memoryTotalBytes ?? null;
  const cores = published?.host?.logicalCores ?? null;
  return (
    <View style={styles.page} testID="machine-processes-owner-page">
      {backLink}
      <OwnerHeader
        owner={owner}
        title={titles.get(owner.owner.rowId) ?? ''}
        serverId={serverId}
        machineId={machineId}
      />
      <ItemGroup header="none">
        <View style={styles.meters}>
          <VitalsMeterRow
            label={t('machineProcesses.tiles.memory')}
            strongLabel
            part={formatProcessMemory(owner.memoryBytes)}
            whole={
              memoryTotal && owner.memoryBytes !== null
                ? `· ${t('machineProcesses.phone.memoryOfMachine', { percent: formatVitalsPercent((owner.memoryBytes / memoryTotal) * 100) })}`
                : ''
            }
            used={owner.memoryBytes ?? 0}
            capacity={memoryTotal ?? Math.max(1, owner.memoryBytes ?? 1)}
            tone="calm"
            accessibilityLabel={`${t('machineProcesses.tiles.memory')} ${formatProcessMemory(owner.memoryBytes)}`}
          />
          <VitalsMeterRow
            label={t('machineProcesses.tiles.cpu')}
            strongLabel
            part={formatProcessCpu(owner.cpuPercent)}
            whole={
              cores
                ? `· ${t('machineProcesses.phone.cpuOfCores', { cores })}`
                : ''
            }
            used={owner.cpuPercent ?? 0}
            capacity={100}
            tone="calm"
            accessibilityLabel={`${t('machineProcesses.tiles.cpu')} ${formatProcessCpu(owner.cpuPercent)}`}
          />
        </View>
      </ItemGroup>
      {owner.owner.ceiling ? <ItemGroup
        title={t('machineProcesses.ceiling.title')}
        description={t('machineProcesses.ceiling.scopeHelp')}
      >
        <Item testID="machine-processes-ceiling-usage" mode="info" title={t('machineProcesses.tiles.memory')}
          detail={formatProcessMemory(owner.memoryBytes, owner.owner.ceiling)} />
        <Item testID="machine-processes-ceiling-throttles" mode="info"
          title={owner.owner.ceiling.throttleCount5m === undefined ? t('machineProcesses.ceiling.throttlesUnknown')
            : t('machineProcesses.ceiling.throttles', { count: owner.owner.ceiling.throttleCount5m })} />
      </ItemGroup> : null}
      <ItemGroup
        title={t('machineProcesses.phone.ownerProcesses', {
          count: owner.processCount,
        })}
      >
        {members.map((item) =>
          item.kind === 'process' ? (
            <Item
              key={item.key}
              testID={`machine-processes-owner-row-${item.key}`}
              title={describeProcessTitle(item.row)}
              subtitle={
                <View style={styles.inline}>
                  <Text
                    style={styles.quiet}
                  >{`${formatProcessCpu(item.cpuPercent)} ${t('machineProcesses.columns.cpu')}`}</Text>
                  <ProcessOwnershipPill level={item.row.level} />
                </View>
              }
              detail={formatProcessMemory(item.memoryBytes)}
              onPress={() =>
                setParams({
                  id: 'processes',
                  page: 'process',
                  process: item.row.ref,
                  owner: owner.owner.rowId,
                })
              }
            />
          ) : null,
        )}
      </ItemGroup>
      <View style={styles.actions}>
        {owner.owner.owner.kind === 'session' ? (
          <>
            <RoundButton
              size="small"
              display="secondary"
              title={t('machineProcesses.menu.openSession')}
              onPress={() =>
                owner.owner.owner.kind === 'session' &&
                controller.openSession(owner.owner.owner.sessionId)
              }
            />
            <RoundButton
              size="small"
              display="secondary"
              title={t('machineProcesses.menu.stopSession')}
              disabled={!online}
              onPress={() => {
                controller.stop(owner);
                back();
              }}
            />
          </>
        ) : null}
        {owner.owner.owner.kind !== 'happier' ? (
          <RoundButton
            size="small"
            display="destructive"
            title={t('machineProcesses.menu.killTree')}
            disabled={!online}
            onPress={() => controller.killTree(owner)}
          />
        ) : null}
      </View>
      <Text style={styles.quiet}>{t('machineProcesses.phone.ownerFoot')}</Text>
    </View>
  );
}

function OwnerHeader(
  props: Readonly<{
    owner: ProcessesOwnerItem;
    title: string;
    serverId: string;
    machineId: string;
  }>,
) {
  const status = useProcessOwnerStatus(props.owner.owner.owner, props.serverId);
  return (
    <View style={styles.header}>
      <View style={styles.inline}>
        <ProcessOwnerMark
          owner={props.owner.owner.owner}
          serverId={props.serverId}
          machineId={props.machineId}
          size={20}
        />
        <Text style={styles.title} numberOfLines={2}>
          {props.title}
        </Text>
      </View>
      {status ? (
        <Text
          style={[styles.quiet, status.color ? { color: status.color } : null]}
        >
          {status.text}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    gap: theme.space.s16,
  },
  header: {
    gap: theme.space.s4,
  },
  title: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('pageTitle'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  meters: {
    gap: 14,
    padding: theme.space.s16,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  quiet: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s8,
  },
}));
