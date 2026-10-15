import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { HAPPIER_DATA_METRICS, HappierDataMetric, HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
  UsageResetCelebration,
  type UsageResetCelebrationWindow,
} from './UsageResetCelebration';
import {
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import type { UsagePlanAccount, UsagePlanPool, UsagePlanWindow } from './plans/usagePlansModel';
import {
  useUsagePlans,
  useUsagePoolSelections,
  type UsagePlanAccountName,
  type UsagePoolSelectionState,
} from './plans/useUsagePlans';
import {
  formatPlanCountdown,
  formatPlanMoment,
  formatPlanPercent,
  planExclusionText,
  UsagePlanRank,
  UsagePlansNothingRead,
  UsagePlanIdentity,
  UsagePlanAccountStates,
  readPendingPlanAccountCount,
  usePlanText,
} from './plans/UsagePlanParts';
import { UsagePoolQueue, UsagePoolSteps } from './plans/UsagePoolOrder';

/** Below this width the bar's cells wrap into a two-up grid instead of shrinking into slivers. */
const CELL_MIN_WIDTH_PX = 92;

type Cell = Readonly<{
  account: UsagePlanAccount;
  rank: number | null;
  selected: boolean;
  excluded: string | null;
}>;
type Run = Readonly<{ pool: UsagePlanPool | null; cells: readonly Cell[] }>;

/**
 * The bar keeps the Account's own order. A pool's members sit together where its first member is, in
 * the selector's own preference order when that read answered; nothing is ranked across pools.
 */
function buildRuns(
  accounts: readonly UsagePlanAccount[],
  pools: readonly UsagePlanPool[],
  selections: ReadonlyMap<string, UsagePoolSelectionState>,
  nowMs: number,
): Run[] {
  const byKey = new Map(accounts.map((account) => [account.key, account]));
  const emitted = new Set<string>();
  const runs: Run[] = [];
  for (const account of accounts) {
    const memberships = pools.filter(pool => pool.accountKeys.includes(account.key));
    if (memberships.length === 0) {
      runs.push({
        pool: null,
        cells: [{ account, rank: null, selected: false, excluded: null }],
      });
      continue;
    }
    for (const pool of memberships) {
      if (emitted.has(pool.key)) continue;
      const selection = selections.get(pool.key);
      const members = pool.accountKeys.map((key) => byKey.get(key)!);
      let cells: Cell[] = members.map((member) => ({
        account: member,
        rank: null,
        selected: false,
        excluded: null,
      }));
      if (
        selection &&
        typeof selection === 'object' &&
        !('status' in selection)
      ) {
        const ordered =
          selection.selection.decisionTrace.orderedEligibleCandidates.map(
            (entry) => entry.profileId,
          );
        const selectedId = selection.selection.selected?.profileId ?? null;
        const excluded = new Map(
          selection.selection.excluded.map((entry) => [
            entry.profileId,
            planExclusionText(entry.reason, entry.retryAtMs ?? null, nowMs),
          ]),
        );
        const position = (accountId: string) => {
          const index = ordered.indexOf(accountId);
          return index < 0 ? Number.POSITIVE_INFINITY : index;
        };
        cells = [...members]
          .sort(
            (left, right) => position(left.accountId) - position(right.accountId),
          )
          .map((member) => ({
            account: member,
            rank: ordered.includes(member.accountId)
              ? ordered.indexOf(member.accountId) + 1
              : null,
            selected: member.accountId === selectedId,
            excluded: excluded.get(member.accountId) ?? null,
          }));
      }
      emitted.add(pool.key);
      runs.push({ pool, cells });
    }
  }
  return runs;
}

/**
 * The runs that sit alone in a two-up row: an account that no pool holds, with no second account after it
 * before a pool (which takes the whole row) or the end.
 */
function readLoneHalfRuns(runs: readonly Run[]): ReadonlySet<Run> {
  const lone = new Set<Run>();
  let first: Run | null = null;
  const closeRow = () => { if (first) lone.add(first); first = null; };
  for (const run of runs) {
    if (run.pool) { closeRow(); continue; }
    if (first) first = null;
    else first = run;
  }
  closeRow();
  return lone;
}

export function UsageCapacityWidget(props: UsageBodyProps) {
  const chartTheme = useUsagePluginTheme();
  const presentation = useWidgetPresentation();
  const width = presentation?.geometry?.width ?? null;
  // A tile says the order as Now → Next → Then (lab `p2pool` U2); the full body lists it with reasons (U1).
  const tile = presentation?.size === 'small';
  const text = usePlanText();
  const plans = useUsagePlans(props.slice, props.model);
  const { projection, nameOf, nowMs } = plans;
  const selections = useUsagePoolSelections(props.slice);
  useWidgetFrameBodyCaption(t('usage.board.plans.capacityCaption'));
  const runs = React.useMemo(
    () => buildRuns(projection.accounts, projection.pools, selections, nowMs),
    [projection.accounts, projection.pools, selections, nowMs],
  );
  // Every window's latest reading, for the one witnessed-reset moment (lab `kitmotion` reset).
  const resetWindows = React.useMemo(
    (): readonly UsageResetCelebrationWindow[] =>
      projection.accounts.flatMap((account) =>
        account.windows.map((window) => ({
          key: window.key,
          resetAtMs: window.resetAtMs,
          remainingFraction: window.remainingFraction,
          name: nameOf(account).title,
          window: window.label,
        })),
      ),
    [projection.accounts, nameOf],
  );
  if (projection.accounts.length === 0) {
    return (
      <View style={styles.body}>
        <UsagePlansNothingRead
          testID={`${props.testID}.none`}
          slice={props.slice}
          onRetry={props.model.refresh}
        />
      </View>
    );
  }
  const tightest = projection.tightest;
  const tightestName = tightest ? nameOf(tightest.account) : null;
  const cellCount = projection.accounts.length;
  // Until the first allowance answers there is no tightest to name, but the headline's room is held: the
  // figure it will be and one quiet line ("Reading 5 accounts…"), so its arrival moves nothing below it.
  const pendingAccounts = readPendingPlanAccountCount(projection.accounts);
  const reading = tightest === null && pendingAccounts > 0;
  // Equal cells while they fit; a narrow frame (a phone) wraps them two-up rather than shrinking them.
  const cellBasis =
    width !== null && width / cellCount < CELL_MIN_WIDTH_PX ? ('46%' as const) : undefined;
  // In the two-up grid an odd account keeps its half: an empty half beside it, never a full-width track.
  const loneRuns = cellBasis ? readLoneHalfRuns(runs) : null;
  return (
    <View style={styles.body} testID={`${props.testID}.capacity`}>
      <UsageResetCelebration
        windows={resetWindows}
        burst={!tile}
        testID={`${props.testID}.resetBurst`}
      />
      {tightest && tightestName ? (
        <View style={styles.hero}>
          <View style={styles.heroLine}>
            <HappierDataMetric
              testID={`${props.testID}.tightest`}
              theme={chartTheme}
              size="hero"
              label={t('usage.board.plans.capacityTightestUnit', {
                name: tightestName.title,
              })}
              value={Math.round(tightest.window.remainingFraction! * 100)}
              valueFormatter={(value) => `${value}%`}
            />
            <Text style={[styles.heroUnit, text.title]} numberOfLines={2}>
              {t('usage.board.plans.capacityTightestUnit', {
                name: tightestName.title,
              })}
            </Text>
          </View>
          <Text style={[styles.subline, text.detail]}>
            {[
              tightest.window.resetAtMs !== null
                ? t('usage.board.plans.capacityResets', {
                    time: formatPlanMoment(tightest.window.resetAtMs, nowMs),
                  })
                : null,
              t('usage.board.plans.capacityAccounts', { count: cellCount }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
      ) : reading ? (
        <CapacityHeroReading count={pendingAccounts} testID={`${props.testID}.reading`} />
      ) : null}
      <View style={styles.bar} accessibilityRole="list">
        {runs.map((run) => (
          <React.Fragment key={run.pool?.key ?? run.cells[0]!.account.key}>
            <View
              style={[
                styles.run,
                run.pool ? styles.pool : null,
                cellBasis
                  ? { flexBasis: run.pool ? '100%' : '47%', flexGrow: 1 }
                  : { flexGrow: run.cells.length, flexBasis: 0 },
              ]}
            >
              {run.cells.map((cell) => (
                <CapacityCell
                  key={cell.account.key}
                  cell={cell}
                  name={nameOf(cell.account)}
                  nowMs={nowMs}
                  basis={run.pool ? cellBasis : undefined}
                  testID={`${props.testID}.cell.${cell.account.accountId}`}
                />
              ))}
            </View>
            {loneRuns?.has(run) ? <View style={styles.halfSpacer} /> : null}
          </React.Fragment>
        ))}
      </View>
      {tile ? (
        <UsagePoolSteps
          serverId={props.serverId}
          pools={projection.pools}
          accounts={projection.accounts}
          selections={selections}
          nameOf={nameOf}
          nowMs={nowMs}
          testID={`${props.testID}.steps`}
        />
      ) : (
        <UsagePoolQueue
          serverId={props.serverId}
          pools={projection.pools}
          accounts={projection.accounts}
          selections={selections}
          nameOf={nameOf}
          nowMs={nowMs}
          testID={`${props.testID}.usedFirst`}
        />
      )}
      <UsagePlanAccountStates
        accounts={projection.accounts}
        nameOf={nameOf}
        slice={props.slice}
        onRetry={props.model.refresh}
        testID={`${props.testID}.state`}
        pendingInHeadline={reading}
      />
    </View>
  );
}

/** The headline's room while the first allowance is still being read: its figure's height and its line. */
function CapacityHeroReading(props: Readonly<{ count: number; testID: string }>) {
  const { theme } = useUnistyles();
  const text = usePlanText();
  const reducedMotion = useReducedMotionPreference();
  return (
    <View style={styles.hero} testID={props.testID}>
      <View style={[styles.heroReading, { height: HAPPIER_DATA_METRICS.heroValue.lineHeight }]}>
        <HappierSkeletonBlock color={theme.colors.surface.pressedOverlay} width={84} height={HAPPIER_DATA_METRICS.heroValue.fontSize * 0.7}
          radius={8} reducedMotion={reducedMotion} />
      </View>
      <Text style={[styles.subline, text.detail]}>{t('usage.board.plans.capacityReading', { count: props.count })}</Text>
    </View>
  );
}

/** A secondary window in one quiet line: its name and what is left of it. */
function windowNote(window: UsagePlanWindow): string {
  return `${window.label} · ${
    window.remainingFraction === null
      ? t('usage.board.plans.cellUnknown')
      : t('usage.board.plans.cellLeft', { percent: formatPlanPercent(window.remainingFraction) })
  }`;
}

function CapacityCell(
  props: Readonly<{
    cell: Cell;
    name: UsagePlanAccountName;
    nowMs: number;
    basis?: `${number}%`;
    testID: string;
  }>,
) {
  const { cell, nowMs } = props;
  const text = usePlanText();
  const window = cell.account.headline;
  // Every other window of the plan, each in its own words; none is folded into the headline.
  const otherWindows = cell.account.windows.filter((other) => other !== window);
  const remaining = window?.remainingFraction ?? null;
  const usedUp = remaining !== null && remaining <= 0;
  const countdown =
    window?.resetAtMs != null
      ? formatPlanCountdown(window.resetAtMs, nowMs)
      : null;
  // Only a state that changes what the viewer can do speaks under the segment (excluded, stale, used
  // up); the ordinary reset is the headline's job (lab ucap/wgusage-CD: one figure, one plan label).
  const staleDetail =
    cell.excluded === null && cell.account.stale && cell.account.observedAtMs !== null
      ? t('usage.board.plans.cellStale', {
          time: formatPlanMoment(cell.account.observedAtMs, nowMs),
        })
      : null;
  // Red belongs to "used up" alone: a stale read of a used-up plan stays the quiet "last read" note.
  const usedUpDetail = cell.excluded === null && staleDetail === null && usedUp && countdown
    ? `${t('usage.board.plans.cellUsedUp')} · ${countdown}`
    : null;
  const detail = cell.excluded ?? staleDetail ?? usedUpDetail;
  const value =
    remaining === null
      ? '—'
      : formatPlanPercent(remaining);
  return (
    <View
      testID={props.testID}
      accessibilityRole="text"
      style={[
        styles.cell,
        props.basis ? { flexBasis: props.basis, flexGrow: 1 } : null,
      ]}
      accessibilityLabel={[
        props.name.title,
        props.name.qualifier,
        window?.label,
        remaining === null
          ? t('usage.board.plans.cellUnknown')
          : t('usage.board.plans.cellLeft', { percent: value }),
        countdown ? t('connectedServicesCollection.meterResetsIn', { time: countdown }) : null,
        detail,
        // Every other window stays readable here and in Projections; none is stacked into the bar.
        ...otherWindows.map((other) => windowNote(other)),
      ]
        .filter(Boolean)
        .join(', ')}
    >
      {/* The bar leads (lab `ucap`): side by side the cells read as one all-accounts bar. An unknown window draws an empty track; no width is invented for it. */}
      <MeterBar
        height={8}
        tone={window && window.tone !== 'success' ? window.tone : 'neutral'}
        fillFraction={remaining ?? 0}
        {...(cell.account.stale ? { fillOpacity: 0.45 } : {})}
      />
      <View style={styles.cellHead}>
        <Text
          style={[
            styles.cellValue,
            text.title,
            remaining === null ? styles.cellValueUnknown : null,
            window?.tone === 'warning'
              ? styles.warning
              : window?.tone === 'danger'
                ? styles.danger
                : null,
          ]}
          numberOfLines={1}
        >
          {value}
        </Text>
      </View>
      <View style={styles.cellHead}>
        <View style={styles.cellIdentity}><UsagePlanIdentity name={props.name} compact /></View>
        {cell.rank !== null || cell.excluded !== null ? (
          <UsagePlanRank rank={cell.rank} selected={cell.selected} />
        ) : null}
      </View>
      {/* The caption's line is held for every account from the first frame, the one that never answers
          included: "last read" or "used up" arrives into it, and settling never resizes the bar. */}
      <Text
        style={[
          styles.cellDetail,
          text.detail,
          { minHeight: text.detail.lineHeight },
          usedUpDetail !== null ? styles.danger : null,
        ]}
        // A narrow segment wraps its note ("last read 07:31") rather than cutting the time off.
        numberOfLines={2}
      >
        {detail}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 18 },
  hero: { gap: theme.space.s2 },
  heroLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: theme.space.s10,
  },
  heroReading: { justifyContent: 'center' },
  heroUnit: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  subline: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  // The gap keeps one cell's account name clear of the next cell's mark; the bars still read as one row.
  bar: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s12, rowGap: theme.space.s12 },
  run: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s12, rowGap: theme.space.s12, minWidth: 0 },
  pool: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    padding: theme.space.s4,
  },
  halfSpacer: { flexBasis: '47%', flexGrow: 1 },
  cell: { flex: 1, minWidth: 0, gap: theme.space.s6 },
  cellHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    minWidth: 0,
  },
  cellIdentity: { flexShrink: 1, minWidth: 0 },
  cellValue: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  cellValueUnknown: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
  },
  cellDetail: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  warning: { color: theme.colors.state.warning.foreground },
  danger: { color: theme.colors.state.danger.foreground },
}));
