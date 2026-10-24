import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { HappierSeries } from '@happier-dev/plugin-ui/presentation';
import type {
  MachineProcessesAnswerV1,
  ProcessOwnerRefV1,
  ProcessRowV1,
  ProcessSampleV1,
  OwnerRowV1,
} from '@happier-dev/protocol/machines/processes/machineProcessesV1';

import {
  formatMachineBytes,
  type MachineVitalsTimeline,
} from '@/components/machines/vitals/machineVitalsPresentation';
import { VitalsHistoryChart } from '@/components/machines/vitals/VitalsHistoryChart';
import {
  formatVitalsPercent,
  vitalsAreaWash,
  vitalsPercentScale,
} from '@/components/machines/vitals/vitalsFormat';
import { usageSignatureAccent } from '@/components/settings/usage/usageAccent';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

import {
  ProcessOwnershipPill,
  ProcessPortChips,
} from './processesCollectionAnatomy';
import { describeProcessTitle } from './processOwnerIdentity';

const HOUR_MS = 60 * 60 * 1000;
/** Two side-by-side columns need about two readable measures. */
const TWO_COLUMN_MIN_WIDTH_PX = 640;

export type ProcessDetailInput = Readonly<{
  row: ProcessRowV1;
  owner: ProcessOwnerRefV1 | null;
  ownerTitle: string | null;
  machineName: string;
  platform: MachineProcessesAnswerV1['platform'];
  homeDir?: string;
  samples: readonly ProcessSampleV1[] | undefined;
  ceiling?: OwnerRowV1['ceiling'];
  onCopyCommand: ((command: string) => void) | null;
  onOpenSession: ((sessionId: string) => void) | null;
}>;

function buildTimeline(
  samples: readonly ProcessSampleV1[],
  nowMs: number,
): MachineVitalsTimeline {
  return {
    start: nowMs - HOUR_MS,
    end: nowMs,
    points: samples.map((sample) => ({
      t: sample.capturedAtMs,
      cpu: sample.cpuPercent ?? null,
      cpuMax: sample.cpuPercent ?? null,
      usedBytes: sample.memoryBytes,
      usedBytesMax: sample.memoryBytes,
      level: 'not_reported' as const,
      rxBps: null,
      txBps: null,
    })),
  };
}

/**
 * A process's detail in place, under its row (lab `rp` D; pushed on a phone, Dp): the command as delivered
 * (redacted on the machine), who started it, how Happier knows it belongs here in the four kinds of
 * evidence, its memory and CPU for the last hour on 0-based scales, and the facts that are always true.
 */
export const ProcessDetail = React.memo(function ProcessDetail(
  props: ProcessDetailInput,
) {
  const { theme } = useUnistyles();
  const { row } = props;
  const [wide, setWide] = React.useState(false);
  const onLayout = React.useCallback(
    (event: LayoutChangeEvent) => {
      const width = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
      if (width !== null) setWide(width >= TWO_COLUMN_MIN_WIDTH_PX);
    },
    [],
  );
  const name = describeProcessTitle(row);
  const sessionId =
    props.owner?.kind === 'session' ? props.owner.sessionId : null;
  const proven = row.level === 'proven';
  // The daemon's lineage ends with the process itself; the crumb names it once, as its own last part.
  const parents = (row.chain ?? []).filter((link) => link.pid !== row.pid);
  return (
    <View
      testID={`machine-processes-detail-${row.ref}`}
      accessibilityLabel={t('machineProcesses.detail.label', { name })}
      style={styles.root}
      onLayout={onLayout}
    >
      <View style={styles.head}>
        {row.command ? (
          <Text
            selectable
            style={styles.command}
            testID="machine-processes-detail-command"
          >
            {row.command}
          </Text>
        ) : null}
        <View style={styles.headActions}>
          {row.command && props.onCopyCommand ? (
            <RoundButton
              size="small"
              display="secondary"
              title={t('machineProcesses.menu.copyCommand')}
              onPress={() => props.onCopyCommand?.(row.command!)}
            />
          ) : null}
          {sessionId && props.onOpenSession ? (
            <RoundButton
              size="small"
              display="secondary"
              title={t('machineProcesses.menu.openSession')}
              onPress={() => props.onOpenSession?.(sessionId)}
            />
          ) : null}
        </View>
      </View>
      {props.ownerTitle || parents.length > 0 ? (
        <View style={styles.chain} accessibilityRole="text">
          <Text style={styles.key}>
            {t('machineProcesses.detail.startedBy')}
          </Text>
          {props.ownerTitle ? (
            <Text style={styles.chainPart}>{props.ownerTitle}</Text>
          ) : null}
          {parents.map((link) => (
            <React.Fragment key={link.pid}>
              <Icon
                name="caret-right"
                size={12}
                color={theme.colors.text.tertiary}
              />
              <Text style={styles.chainPart}>{link.name}</Text>
              {link.exitedAtMs ? (
                <Text style={styles.quiet}>
                  {t('machineProcesses.detail.quitAt', {
                    time: formatAsOfTime(link.exitedAtMs),
                  })}
                </Text>
              ) : null}
            </React.Fragment>
          ))}
          <Icon
            name="caret-right"
            size={12}
            color={theme.colors.text.tertiary}
          />
          <Text style={[styles.chainPart, styles.chainSelf]}>{row.name}</Text>
        </View>
      ) : null}
      <View style={[styles.columns, wide ? styles.columnsWide : null]}>
        <View style={[styles.column, wide ? styles.columnWide : null]}>
          <View style={styles.keyRow}>
            <Text style={styles.key}>
              {t('machineProcesses.detail.howHappierKnows')}
            </Text>
            <ProcessOwnershipPill level={row.level} />
          </View>
          {row.evidence ? null : (
            // The evidence arrives with the detail read, a moment after the row; until then say so rather than leave the section bare.
            <Text
              style={styles.quiet}
              testID="machine-processes-evidence-loading"
            >
              {t('common.loading')}
            </Text>
          )}
          {(row.evidence ?? []).map((entry) => (
            <View
              key={entry.kind}
              style={styles.evidence}
              testID={`machine-processes-evidence-${entry.kind}-${entry.state}`}
            >
              <Icon
                name={entry.state === 'met' ? 'check' : 'minus-circle'}
                size={14}
                color={
                  entry.state === 'met'
                    ? theme.colors.text.primary
                    : theme.colors.text.tertiary
                }
              />
              <View style={styles.evidenceText}>
                <Text
                  style={
                    entry.state === 'met'
                      ? styles.evidenceTitle
                      : styles.evidenceTitleQuiet
                  }
                >
                  {t(`machineProcesses.detail.evidence.${entry.kind}`)}
                </Text>
                <Text style={styles.quiet}>
                  {t(`machineProcesses.detail.reasons.${entry.reason}`)}
                </Text>
              </View>
            </View>
          ))}
          {proven ? null : (
            <Text style={styles.quiet}>
              {row.level === 'left_behind'
                ? t('machineProcesses.detail.leftBehindWhy')
                : t('machineProcesses.detail.likelyWhy')}
            </Text>
          )}
          <Text style={styles.platform}>
            {t(`machineProcesses.platform.${props.platform}`)}
          </Text>
        </View>
        <View style={[styles.column, wide ? styles.columnWide : null]}>
          <ProcessHistory
            row={row}
            samples={props.samples}
            machineName={props.machineName}
          />
          <ItemGroup header="none">
            {row.ports && row.ports.length > 0 ? (
              <Item
                title={t('machineProcesses.detail.facts.port')}
                mode="info"
                showChevron={false}
                density="compact"
                rightElement={
                  <View style={styles.inline}>
                    <ProcessPortChips ports={row.ports} />
                  </View>
                }
              />
            ) : null}
            <Item
              title={t('machineProcesses.detail.facts.folder')}
              mode="info"
              showChevron={false}
              density="compact"
              detailStyle={styles.mono}
              detail={
                props.platform === 'win32'
                  ? t('machineProcesses.detail.cwdUnavailableWindows')
                  : row.cwd
                    ? formatPathRelativeToHome(row.cwd, props.homeDir)
                    : '—'
              }
            />
            <Item
              title={t('machineProcesses.detail.facts.running')}
              mode="info"
              showChevron={false}
              density="compact"
              detail={t('machineProcesses.kill.runningSince', {
                time: formatAsOfTime(row.startedAtMs),
                duration: formatRelativeTimeShort(row.startedAtMs, Date.now()),
              })}
            />
            <Item
              title={t('machineProcesses.detail.facts.process')}
              mode="info"
              showChevron={false}
              density="compact"
              detailStyle={styles.tabular}
              detail={
                row.principalName
                  ? t('machineProcesses.detail.processValue', {
                      pid: row.pid,
                      user: row.principalName,
                    })
                  : String(row.pid)
              }
            />
          </ItemGroup>
          {props.ceiling ? <ItemGroup title={t('machineProcesses.ceiling.title')} description={t('machineProcesses.ceiling.scopeHelp')}>
            <Item mode="info" title={t('machineProcesses.tiles.memory')} detail={t('machineProcesses.ceiling.usage', {
              used: props.ceiling.usedBytes === undefined ? '—' : formatMachineBytes(props.ceiling.usedBytes, 'memory'),
              limit: formatMachineBytes(props.ceiling.limitBytes, 'memory'),
            })} />
            <Item mode="info" testID="machine-processes-ceiling-throttles"
              title={props.ceiling.throttleCount5m === undefined ? t('machineProcesses.ceiling.throttlesUnknown')
                : t('machineProcesses.ceiling.throttles', { count: props.ceiling.throttleCount5m })} />
          </ItemGroup> : null}
        </View>
      </View>
    </View>
  );
});

/** Memory and CPU for the last hour through the vitals chart owner; CPU on a fixed 0–100 % of the machine. */
function ProcessHistory(
  props: Readonly<{
    row: ProcessRowV1;
    samples: readonly ProcessSampleV1[] | undefined;
    machineName: string;
  }>,
) {
  const language = usePreferredLanguage();
  const { theme } = useUnistyles();
  const accent = usageSignatureAccent(theme);
  const samples = props.samples ?? [];
  const nowMs =
    samples.length > 0 ? samples[samples.length - 1]!.capturedAtMs : Date.now();
  const timeline = React.useMemo(
    () => buildTimeline(samples, nowMs),
    [nowMs, samples],
  );
  const memoryKind = props.row.memoryKind
    ? t(`machineProcesses.detail.memoryKinds.${props.row.memoryKind}`)
    : t('machineProcesses.columns.memory');
  const memoryMax =
    Math.max(
      1,
      ...samples.map((sample) => sample.memoryBytes ?? 0),
      props.row.memoryBytes ?? 0,
    ) * 1.25;
  const memorySeries = React.useMemo(
    (): readonly HappierSeries[] => [
      {
        id: 'memory',
        label: memoryKind,
        color: accent,
        fillOpacity: vitalsAreaWash(theme.dark),
        points: samples.map((sample) => ({
          id: String(sample.capturedAtMs),
          x: sample.capturedAtMs,
          y: sample.memoryBytes,
        })),
      },
    ],
    [accent, memoryKind, samples, theme.dark],
  );
  const cpuSeries = React.useMemo(
    (): readonly HappierSeries[] => [
      {
        id: 'cpu',
        label: t('machineProcesses.columns.cpu'),
        color: accent,
        points: samples.map((sample) => ({
          id: String(sample.capturedAtMs),
          x: sample.capturedAtMs,
          y: sample.cpuPercent ?? null,
        })),
      },
    ],
    [language, accent, samples],
  );
  const axis = [
    t('machineProcesses.detail.hourAgo'),
    t('machineProcesses.detail.now'),
  ] as const;
  const formatMemory = (value: number) => formatMachineBytes(value, 'memory');
  return (
    <View style={styles.history}>
      <View style={styles.keyRow}>
        <Text style={styles.key}>{memoryKind}</Text>
        <Text style={styles.value}>
          {props.row.memoryBytes === null
            ? '—'
            : formatMemory(props.row.memoryBytes)}
        </Text>
      </View>
      {samples.length > 1 ? (
        <VitalsHistoryChart
          label={memoryKind}
          timeline={timeline}
          series={memorySeries}
          variant="area"
          domain={{ min: 0, max: memoryMax }}
          scaleTicks={[
            { value: memoryMax / 2, label: formatMemory(memoryMax / 2) },
            { value: memoryMax, label: formatMemory(memoryMax) },
          ]}
          axis={['', '']}
          format={formatMemory}
          freshness="live"
          live
          testID="machine-processes-detail-memory"
        />
      ) : (
        <Text style={styles.quiet}>
          {t('machineProcesses.detail.noHistory')}
        </Text>
      )}
      <Text style={styles.quiet}>
        {t('machineProcesses.detail.memoryShared')}
      </Text>
      <View style={styles.keyRow}>
        <Text style={styles.key}>{t('machineProcesses.columns.cpu')}</Text>
        <Text style={styles.value}>
          {props.row.cpuPercent === undefined
            ? '—'
            : `${formatVitalsPercent(props.row.cpuPercent)}%`}
        </Text>
        <Text style={styles.quiet}>
          {t('machineProcesses.detail.cpuOf', { machine: props.machineName })}
        </Text>
      </View>
      {samples.length > 1 ? (
        <VitalsHistoryChart
          label={t('machineProcesses.columns.cpu')}
          timeline={timeline}
          series={cpuSeries}
          variant="line"
          domain={vitalsPercentScale.domain}
          scaleTicks={vitalsPercentScale.ticks}
          axis={axis}
          format={(value) => `${formatVitalsPercent(value)}%`}
          freshness="live"
          live
          testID="machine-processes-detail-cpu"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: 14,
    paddingVertical: theme.space.s12,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s12,
  },
  headActions: {
    flexDirection: 'row',
    gap: theme.space.s8,
    marginLeft: 'auto',
  },
  command: {
    ...Typography.mono(),
    ...Typography.variant('meta'),
    fontFamily: Typography.mono().fontFamily,
    color: theme.colors.text.primary,
    backgroundColor: theme.colors.surface.inset,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.space.s10,
    paddingVertical: theme.space.s6,
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '100%',
    // A path or hash in a command has no break opportunity; without this it runs past the page's right gutter.
    ...(Platform.OS === 'web' ? ({ overflowWrap: 'anywhere' } as const) : {}),
  },
  chain: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s6,
  },
  chainPart: {
    ...Typography.variant('meta'),
    color: theme.colors.text.primary,
  },
  chainSelf: {
    ...Typography.default('medium'),
  },
  columns: {
    gap: theme.space.s20,
  },
  columnsWide: {
    flexDirection: 'row',
  },
  column: {
    gap: theme.space.s10,
    minWidth: 0,
  },
  columnWide: {
    flex: 1,
  },
  keyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  key: {
    ...Typography.variant('meta'),
    ...Typography.default('medium'),
    color: theme.colors.text.secondary,
  },
  value: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    ...Typography.default('medium'),
    color: theme.colors.text.primary,
  },
  evidence: {
    flexDirection: 'row',
    gap: theme.space.s8,
    alignItems: 'flex-start',
  },
  evidenceText: {
    flex: 1,
    gap: 1,
  },
  evidenceTitle: {
    ...Typography.default(),
    color: theme.colors.text.primary,
  },
  evidenceTitleQuiet: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
  },
  quiet: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  platform: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    marginTop: theme.space.s4,
  },
  history: {
    gap: theme.space.s8,
  },
  inline: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    flexShrink: 1,
    minWidth: 0,
    gap: theme.space.s6,
    // Wrapped chips grow the row past its single line; the padding keeps the first and last line off the card's edges.
    paddingVertical: theme.space.s6,
  },
  mono: {
    ...Typography.mono(),
  },
  tabular: {
    ...Typography.tabular(),
  },
}));
