import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  CollectionAnatomy,
  CollectionField,
  CollectionSummaryRow,
} from '@happier-dev/plugin-ui';
import {
  StackedSeriesChart,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';
import type {
  MachineProcessesAnswerV1,
  ProcessOwnershipLevelV1,
  ProcessSampleV1,
  OwnerRowV1,
} from '@happier-dev/protocol/machines/processes/machineProcessesV1';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { formatVitalsPercent } from '@/components/machines/vitals/vitalsFormat';
import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';

import { resolveOwnershipLabel } from './ownershipLabelPresentation';
import { ProcessPortChip } from './ProcessPortMenu';
import {
  describeProcessTitle,
  processGlyphName,
  ProcessOwnerMark,
  useProcessOwnerStatus,
} from './processOwnerIdentity';
import {
  isProcessRowEmphasized,
  type MachineProcessesTotals,
  type ProcessesItem,
} from './processesPresentation';

/** Why a row came back after a stop that did not happen ("It didn't stop"), by row key; the tab provides it. */
export const ProcessesRowNotesContext = React.createContext<ReadonlyMap<string, string>>(new Map());

/** A trend is drawn only where something moves (lab `rp` H): a flat line is noise. */
const SPARK_MIN_SPREAD_PERCENT = 0.2;

export type ProcessesAnatomyInput = Readonly<{
  serverId: string;
  machineId: string;
  machineName: string;
  /** Owner titles from {@link useProcessOwnerTitles}. */
  titles: ReadonlyMap<string, string>;
  logicalCores: number | null;
  history?: MachineProcessesAnswerV1['history'];
  /** A phone row: CPU and the status under the name, memory at the right (lab `rp` Hp). */
  compact: boolean;
  /** The same rows with nothing to act on (Overview's "Using the most", plan 60's tool body). */
  readOnly?: boolean;
  /** Rows leave through this wrapper (stop-and-ease); read-only callers omit it. */
  wrapItem?: (item: ProcessesItem, content: React.ReactNode) => React.ReactNode;
}>;

export function formatProcessCpu(value: number | null): string {
  return value === null ? '—' : `${formatVitalsPercent(value)}%`;
}

export function formatProcessMemory(value: number | null, ceiling?: OwnerRowV1['ceiling']): string {
  if (ceiling) return t('machineProcesses.ceiling.usage', {
    used: ceiling.usedBytes === undefined ? '—' : formatMachineBytes(ceiling.usedBytes, 'memory'),
    limit: formatMachineBytes(ceiling.limitBytes, 'memory'),
  });
  return value === null ? '—' : formatMachineBytes(value, 'memory');
}

/** The name a row shows: owners by the identity owner, processes in plain words, groups by what they are. */
export function describeProcessesItemTitle(
  item: ProcessesItem,
  titles: ReadonlyMap<string, string>,
): string {
  switch (item.kind) {
    case 'owner':
      return titles.get(item.owner.rowId) ?? item.owner.rowId;
    case 'process':
      return describeProcessTitle(item.row);
    case 'leftBehind':
      return describeProcessTitle(item.row);
    case 'fold':
      return item.reason === 'mcp'
        ? t('machineProcesses.fold.mcp', { count: item.count })
        : t('machineProcesses.fold.idle', { count: item.count });
    case 'happier':
      return t('machineProcesses.owners.happier');
    case 'app':
      return item.app.appGroup;
    case 'appMember':
      return item.row.name;
    case 'otherPeople':
      return item.names.length > 0
        ? item.names.join(', ')
        : t('machineProcesses.allRows.otherPeopleFallback');
  }
}

function levelOf(item: ProcessesItem): ProcessOwnershipLevelV1 {
  if (item.kind === 'process') return item.row.level;
  if (item.kind === 'leftBehind') return 'left_behind';
  if (item.kind === 'owner') return 'proven';
  return 'not_happier';
}

function describeRowDetail(item: ProcessesItem): string {
  const label =
    item.kind === 'process' || item.kind === 'leftBehind'
      ? resolveOwnershipLabel(levelOf(item))
      : null;
  return label ? t(label.labelKey) : '';
}

/** The quiet ownership word + glyph, only where ownership is not proven (R14). */
export const ProcessOwnershipPill = React.memo(function ProcessOwnershipPill(
  props: Readonly<{ level: ProcessOwnershipLevelV1; testID?: string }>,
) {
  const { theme } = useUnistyles();
  const label = resolveOwnershipLabel(props.level);
  if (!label) return null;
  const color =
    label.variant === 'attention'
      ? (theme.colors.state.attention.textForeground ??
        theme.colors.state.attention.foreground)
      : theme.colors.text.secondary;
  return (
    <StatusPill
      testID={props.testID}
      chrome="plain"
      variant={label.variant}
      labelVariant="phrase"
      label={t(label.labelKey)}
      foregroundColor={color}
      leading={<Icon name={label.icon} size={12} color={color} />}
    />
  );
});

/**
 * A listener on the process that owns it (`:5173`), in the mono chip the lab draws. Given the row it
 * sits on (the tab's tree, not a read-only surface), each chip opens its Local services menu.
 */
export const ProcessPortChips = React.memo(function ProcessPortChips(
  props: Readonly<{
    ports: readonly Readonly<{ port: number; inventoryEntryId?: string }>[];
    actionable?: Readonly<{ item: ProcessesItem; ownerTitle: string }>;
    /** A phone row has room for a couple of chips; the rest say how many more the owner's page lists. */
    max?: number;
  }>,
) {
  if (props.ports.length === 0) return null;
  const { actionable } = props;
  const shown = props.max === undefined ? props.ports : props.ports.slice(0, props.max);
  const hidden = props.ports.length - shown.length;
  return (
    <>
      {shown.map((port) =>
        actionable && port.inventoryEntryId ? (
          <ProcessPortChip
            key={port.port}
            port={port.port}
            inventoryEntryId={port.inventoryEntryId}
            item={actionable.item}
            ownerTitle={actionable.ownerTitle}
          />
        ) : (
          <StatusPill
            key={port.port}
            variant="neutral"
            hideDot
            label={`:${port.port}`}
            labelStyle={styles.mono}
          />
        ),
      )}
      {hidden > 0 ? (
        <Text numberOfLines={1} style={styles.moreChips}>{`+${hidden}`}</Text>
      ) : null}
    </>
  );
});

/** The chip's menu for rows of the tab's tree; read-only surfaces draw the chip alone. */
function portActions(
  input: ProcessesAnatomyInput,
  item: ProcessesItem,
  ownerRowId: string,
): Readonly<{ item: ProcessesItem; ownerTitle: string }> | undefined {
  return input.readOnly
    ? undefined
    : { item, ownerTitle: input.titles.get(ownerRowId) ?? ownerRowId };
}

/** The rest of a row's line: a session's status word or what a process is running, its label and its ports. */
const ProcessRowWhere = React.memo(function ProcessRowWhere(
  props: Readonly<{ item: ProcessesItem; input: ProcessesAnatomyInput }>,
) {
  const { item, input } = props;
  switch (item.kind) {
    case 'owner':
      return <OwnerWhere item={item} input={input} />;
    case 'process':
      return (
        <View style={styles.where}>
          {item.row.driverLabel || item.row.command && !input.compact ? (
            <Text numberOfLines={1} style={styles.command}>
              {item.row.driverLabel ?? item.row.command}
            </Text>
          ) : null}
          <ProcessOwnershipPill level={item.row.level} testID={`machine-processes-label-${item.key}`} />
          <ProcessPortChips
            ports={item.row.ports ?? []}
            actionable={portActions(input, item, item.owner.rowId)}
            max={input.compact ? 2 : undefined}
          />
        </View>
      );
    case 'leftBehind':
      return (
        <View style={styles.where}>
          <LeftBehindOwnerLine item={item} serverId={input.serverId} />
          {/* On a phone the line says why the row is here (its session and when it ended); the ports are on the review. */}
          <ProcessPortChips
            ports={input.compact ? [] : (item.row.ports ?? [])}
            actionable={portActions(input, item, item.key)}
          />
        </View>
      );
    case 'happier':
      return (
        <Text numberOfLines={1} style={styles.quiet}>
          {t('machineProcesses.allRows.happier', {
            owners: item.ownerCount,
            processes: item.processCount,
          })}
        </Text>
      );
    case 'app':
    case 'otherPeople':
      return (
        <Text numberOfLines={1} style={styles.quiet}>
          {t('machineProcesses.owners.processCount', { count: item.count })}
        </Text>
      );
    default:
      return null;
  }
});

function OwnerWhere(
  props: Readonly<{
    item: Extract<ProcessesItem, { kind: 'owner' }>;
    input: ProcessesAnatomyInput;
  }>,
) {
  const { item, input } = props;
  const note = React.useContext(ProcessesRowNotesContext).get(item.key);
  const { theme } = useUnistyles();
  const status = useProcessOwnerStatus(item.owner.owner, input.serverId);
  const stopping = item.owner.state === 'stopping';
  const text = note ?? (
    item.matchCount !== null
      ? t('machineProcesses.owners.matches', {
          count: item.matchCount,
          total: item.processCount,
        })
      : stopping
        ? t('machineProcesses.owners.stopping')
        : item.owner.owner.kind === 'happier' && !item.owner.owner.component
          ? // The phone's line is the CPU and the ports (lab `rp` Hp); what Happier is for reads in the table.
            input.compact
            ? null
            : t('machineProcesses.owners.keepsConnected', {
                machine: input.machineName,
              })
          : status && item.hasChildren
            ? t('machineProcesses.owners.statusWithCount', {
                status: status.text,
                count: item.processCount,
              })
            : (status?.text ??
              (item.hasChildren
                ? t('machineProcesses.owners.processCount', {
                    count: item.processCount,
                  })
                : null)));
  return (
    <View style={styles.where}>
      {text ? (
        <Text
          numberOfLines={1}
          style={[
            styles.quiet,
            note
              ? { color: theme.colors.state.attention.textForeground ?? theme.colors.state.attention.foreground }
              : status?.color && !stopping && item.matchCount === null
                ? { color: status.color }
                : null,
          ]}
        >
          {text}
        </Text>
      ) : null}
      <ProcessPortChips
        ports={item.ports}
        actionable={portActions(input, item, item.owner.rowId)}
        max={input.compact ? 2 : undefined}
      />
    </View>
  );
}

function LeftBehindOwnerLine(
  props: Readonly<{
    item: Extract<ProcessesItem, { kind: 'leftBehind' }>;
    serverId: string;
  }>,
) {
  const owner = props.item.row.owner;
  const addresses = React.useMemo(
    () =>
      owner.kind === 'session'
        ? [{ sessionId: owner.sessionId, serverId: props.serverId }]
        : [],
    [owner, props.serverId],
  );
  const [title] = useSessionDisplayTitles(addresses);
  const when = formatRelativeTimeShort(
    props.item.row.confirmedAtMs,
    Date.now(),
  );
  return (
    <Text numberOfLines={1} style={styles.quiet}>
      {t('machineProcesses.leftBehindRow', {
        owner: title ?? t('machineProcesses.endedOwner'),
        when,
      })}
    </Text>
  );
}

/** CPU or memory, tabular at the end; a row that uses a full core or was left behind reads in ink. */
const ProcessFigure = React.memo(function ProcessFigure(
  props: Readonly<{ text: string; strong: boolean; testID?: string }>,
) {
  return (
    <Text
      testID={props.testID}
      numberOfLines={1}
      style={[styles.figure, props.strong ? styles.figureStrong : null]}
    >
      {props.text}
    </Text>
  );
});

/** The inline trend through the one chart owner, only where something moves. */
const ProcessSpark = React.memo(function ProcessSpark(
  props: Readonly<{
    samples: readonly ProcessSampleV1[] | undefined;
    label: string;
  }>,
) {
  const { theme } = useUnistyles();
  const pluginTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
  const series = React.useMemo((): readonly HappierSeries[] | null => {
    const values = (props.samples ?? []).flatMap((sample) =>
      typeof sample.cpuPercent === 'number' ? [sample.cpuPercent] : [],
    );
    if (
      values.length < 2 ||
      Math.max(...values) - Math.min(...values) < SPARK_MIN_SPREAD_PERCENT
    )
      return null;
    return [
      {
        id: 'cpu',
        label: props.label,
        color: theme.colors.text.secondary,
        points: (props.samples ?? []).map((sample) => ({
          id: String(sample.capturedAtMs),
          x: sample.capturedAtMs,
          y: sample.cpuPercent ?? null,
        })),
      },
    ];
  }, [props.label, props.samples, theme.colors.text.secondary]);
  if (!series) return null;
  return (
    <StackedSeriesChart
      theme={pluginTheme}
      label={props.label}
      series={series}
      variant="line"
      size="inline"
      fitLine
      width={84}
    />
  );
});

function figureStrong(
  item: ProcessesItem,
  logicalCores: number | null,
): boolean {
  if (item.kind === 'owner' || item.kind === 'happier' || item.kind === 'app') return true;
  return isProcessRowEmphasized(
    { cpuPercent: item.cpuPercent, level: levelOf(item) },
    logicalCores,
  );
}

function ProcessGlyph(
  props: Readonly<{ item: ProcessesItem; input: ProcessesAnatomyInput }>,
) {
  const { theme } = useUnistyles();
  const { item, input } = props;
  if (item.kind === 'owner')
    return (
      <ProcessOwnerMark
        owner={item.owner.owner}
        serverId={input.serverId}
        machineId={input.machineId}
      />
    );
  if (item.kind === 'happier')
    return (
      <Icon name="crosshair" size={16} color={theme.colors.text.secondary} />
    );
  if (item.kind === 'app')
    return (
      <Icon name="desktop" size={16} color={theme.colors.text.secondary} />
    );
  if (item.kind === 'otherPeople')
    return <Icon name="lock" size={16} color={theme.colors.text.tertiary} />;
  if (item.kind === 'fold') return null;
  const glyph =
    item.kind === 'appMember' ? null : processGlyphName(item.row.role);
  return glyph ? (
    <Icon name={glyph} size={16} color={theme.colors.text.secondary} />
  ) : (
    <StatusDot color={theme.colors.text.tertiary} size={5} />
  );
}

/**
 * The one row anatomy for Processes (plan 30 §10.1): the tab's tree, the Overview's "Using the most"
 * (VU-7, `readOnly` + owners only) and plan 60's tool body all draw these rows. Sorting is the caller's:
 * pass {@link buildMachineProcessesView}'s items; CPU and Memory headers sort when the Collection is given `sort`.
 */
export function useProcessesCollectionAnatomy(
  input: ProcessesAnatomyInput,
): CollectionAnatomy<ProcessesItem> {
  const language = usePreferredLanguage();
  return React.useMemo((): CollectionAnatomy<ProcessesItem> => {
    const title = (item: ProcessesItem) =>
      describeProcessesItemTitle(item, input.titles);
    const cpu = (item: ProcessesItem) => (
      <ProcessFigure
        text={formatProcessCpu(item.cpuPercent)}
        strong={figureStrong(item, input.logicalCores)}
      />
    );
    const memory = (item: ProcessesItem) => (
      <ProcessFigure
        testID={`machine-processes-memory-${item.key}`}
        text={formatProcessMemory(item.memoryBytes, item.kind === 'owner' ? item.owner.ceiling : undefined)}
        strong={figureStrong(item, input.logicalCores)}
      />
    );
    const historyOf = (item: ProcessesItem) =>
      item.kind === 'owner'
        ? input.history?.[item.owner.rowId]
        : item.kind === 'process'
          ? input.history?.[item.row.ref]
          : undefined;
    const fields: CollectionField<ProcessesItem>[] = input.compact
      ? []
      : [
          ...(input.history
            ? [
                {
                  key: 'trend',
                  title: t('machineProcesses.columns.trend'),
                  minWidth: 84,
                  priority: 1,
                  render: (item: ProcessesItem) => (
                    <ProcessSpark
                      samples={historyOf(item)}
                      label={title(item)}
                    />
                  ),
                },
              ]
            : []),
          {
            key: 'cpu',
            title: t('machineProcesses.columns.cpu'),
            minWidth: 56,
            priority: 3,
            align: 'end',
            sortable: true,
            render: cpu,
          },
          {
            key: 'memory',
            title: t('machineProcesses.columns.memory'),
            minWidth: 72,
            priority: 4,
            align: 'end',
            sortable: true,
            render: memory,
          },
        ];
    return {
      glyph: (item) => <ProcessGlyph item={item} input={input} />,
      title,
      ...(input.compact
        ? {
            // Phone (lab `rp` Hp): the name takes the row, CPU and the status beneath, memory at the right.
            byline: (item: ProcessesItem) => (
              <View style={[styles.where, styles.clip]}>
                {item.cpuPercent === null ? null : (
                  <Text
                    numberOfLines={1}
                    style={[styles.quiet, styles.cpuLine]}
                  >{`${formatProcessCpu(item.cpuPercent)} ${t('machineProcesses.columns.cpu')}`}</Text>
                )}
                <ProcessRowWhere item={item} input={input} />
              </View>
            ),
            reason: memory,
          }
        : {
            // The table keeps the status, command, label and ports on the title line (lab `rp` H); a table too
            // narrow for its columns says them on the list row's second line.
            titleSuffix: (item: ProcessesItem) => (
              <ProcessRowWhere item={item} input={input} />
            ),
            byline: (item: ProcessesItem) => (
              <ProcessRowWhere item={item} input={input} />
            ),
          }),
      fields,
      accessibilityLabel: (item) =>
        t('machineProcesses.a11y.row', {
          name: title(item),
          detail: describeRowDetail(item),
          cpu: formatProcessCpu(item.cpuPercent),
          memory: formatProcessMemory(item.memoryBytes),
        }),
      testID: (item) => `machine-processes-row-${item.key}`,
      columnTitles: { title: t('machineProcesses.columns.happier') },
      ...(input.wrapItem && !input.readOnly
        ? { wrapItem: input.wrapItem }
        : {}),
    };
  }, [language, input]);
}

/** "Happier in total" and "Everything else on <machine>" (lab `rp` H; VU-7's two closing rows). */
export function buildProcessesSummaryRows(
  input: Readonly<{
    totals: MachineProcessesTotals;
    machineName: string;
    /** The way into All processes on the second row ("Show all processes"), where the viewer may use it. */
    showAll?: React.ReactNode;
    /** The way into the Processes tab on the first row (Overview's "N in Processes", lab `rv` O). */
    happierLink?: React.ReactNode;
  }>,
): readonly CollectionSummaryRow[] {
  const { totals } = input;
  return [
    {
      key: 'happier-total',
      testID: 'machine-processes-total-happier',
      title: input.happierLink ? (
        <View style={styles.where}>
          <Text style={styles.quiet}>{t('machineProcesses.totals.happier')}</Text>
          {input.happierLink}
        </View>
      ) : (
        t('machineProcesses.totals.happier')
      ),
      cells: {
        cpu: (
          <ProcessFigure
            text={formatProcessCpu(totals.happier.cpuPercent)}
            strong={false}
          />
        ),
        memory: (
          <ProcessFigure
            testID="machine-processes-total-happier-memory"
            text={formatProcessMemory(totals.happier.memoryBytes)}
            strong={false}
          />
        ),
      },
    },
    {
      key: 'everything-else',
      testID: 'machine-processes-total-else',
      title: (
        <View style={styles.where}>
          <Text numberOfLines={1} style={styles.quiet}>
            {t('machineProcesses.totals.everythingElse', {
              machine: input.machineName,
            })}
          </Text>
          {input.showAll}
        </View>
      ),
      cells: {
        cpu: (
          <ProcessFigure
            text={formatProcessCpu(totals.everythingElse.cpuPercent)}
            strong={false}
          />
        ),
        memory: (
          <ProcessFigure
            text={formatProcessMemory(totals.everythingElse.memoryBytes)}
            strong={false}
          />
        ),
      },
    },
  ];
}

const styles = StyleSheet.create((theme) => ({
  where: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
    flexShrink: 1,
  },
  quiet: {
    ...Typography.rowMeta(),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  // The phone line's CPU figure never gives its width to the status or chips beside it.
  cpuLine: {
    flexShrink: 0,
  },
  clip: {
    overflow: 'hidden',
  },
  moreChips: {
    ...Typography.rowMeta(),
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
    flexShrink: 0,
  },
  command: {
    ...Typography.mono(),
    ...Typography.rowMeta(),
    fontFamily: Typography.mono().fontFamily,
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  mono: {
    ...Typography.mono(),
  },
  figure: {
    ...Typography.rowMeta(),
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
    textAlign: 'right',
  },
  figureStrong: {
    ...Typography.default('medium'),
    color: theme.colors.text.primary,
  },
}));
