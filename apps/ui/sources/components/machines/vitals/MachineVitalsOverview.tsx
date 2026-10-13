import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_DATA_METRICS,
  HappierSkeletonBlock,
} from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import { readMachinePublishedResources } from '@/components/machines/summary/machineResourceSentences';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useMachineVitalsOverview } from '@/sync/domains/machines/resources/useMachineVitalsOverview';
import { useMachineVitalsAttribution } from '@/sync/domains/machines/resources/useMachineVitalsAttribution';
import { MachineUsingTheMost } from './MachineUsingTheMost';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import { CpuTile } from './CpuTile';
import { DiskTile } from './DiskTile';
import { MachineAlertsRow } from './MachineAlertsRow';
import { MachineMoreFrom } from './MachineMoreFrom';
import {
  buildMachineVitalsTimeline,
  selectMachineVitalsExtras,
  selectMachineVitalsOverviewView,
  type MachineVitalsOverviewView,
} from './machineVitalsPresentation';
import {
  MachineVitalsRangeBar,
  resolveVitalsFreshnessChip,
  useMachineVitalsRange,
} from './MachineVitalsRangeBar';
import { MemoryTile } from './MemoryTile';
import { NetworkTile } from './NetworkTile';
import { VitalsSheet, VitalsTile } from './VitalsSheet';
import { resolveVitalsAxis } from './vitalsFormat';

const ARRIVAL_FADE_MS = 160;

/**
 * Plan 20's vitals body on a machine's Overview (VU-6, lab `rv` O / OE / OX / OS): the freshness chip and
 * history range, the four vitals in one sheet, what else the machine reports, and its Alerts row. Live
 * only while shown (the hook's demand); every state keeps the same boxes, so nothing moves when the first
 * sample lands, when it goes stale, or when the machine leaves.
 */
export const MachineVitalsOverview = React.memo(function MachineVitalsOverview(
  props: Readonly<{
    serverId: string;
    machine: Machine;
    machineName: string;
    online: boolean;
    /** The page draws the freshness chip and range at the end of its tab bar; the body leaves them out. */
    rangeInBar?: boolean;
    /** Opens the Processes tab (VU-7's rows and links); without it "Using the most" is left out. */
    onOpenProcesses?: () => void;
  }>,
) {
  const { machine } = props;
  const daemonState: unknown = machine.daemonState;
  const published = React.useMemo(
    () => readMachinePublishedResources(daemonState),
    [daemonState],
  );
  const [range] = useMachineVitalsRange();
  const overview = useMachineVitalsOverview({
    serverId: props.serverId,
    machineId: machine.id,
    daemonStateVersion: machine.daemonStateVersion ?? null,
    range,
    enabled: props.online,
  });
  const view = selectMachineVitalsOverviewView({
    online: props.online,
    published,
    state: overview,
  });
  // Only an Overview that opened on reserved boxes cross-fades its first sample in.
  const [startedLoading] = React.useState(view.kind === 'loading');
  const attention =
    published?.attention ?? overview.snapshot?.attention ?? null;
  const timeline = React.useMemo(
    () =>
      buildMachineVitalsTimeline({
        range,
        history: overview.history,
        samples: overview.samples,
      }),
    [overview.history, overview.samples, range],
  );
  const { retry } = overview;
  // What Happier uses — processes (plan 30) and what it keeps on each volume (plan 40) — through the one
  // attribution owner, only while this Overview shows a reading.
  const attribution = useMachineVitalsAttribution({ machineId: machine.id, serverId: props.serverId, online: props.online,
    enabled: props.online && view.kind === 'ready', sample: view.kind === 'ready' ? view.sample : null });
  const storageSummary = attribution.storage.summary;
  const happierBytesByVolume = React.useMemo(() => storageSummary
    ? new Map(storageSummary.volumes.map((entry) => [entry.volume.volumeId, entry.happierBytes])) : null, [storageSummary]);

  if (
    view.kind === 'older_happier' ||
    view.kind === 'unavailable' ||
    view.kind === 'offline_empty'
  ) {
    return (
      <MachineVitalsStateCard
        view={view}
        serverId={props.serverId}
        machine={machine}
        machineName={props.machineName}
        onRetry={retry}
      />
    );
  }

  const freshness = resolveVitalsFreshnessChip(view, retry);
  return (
    <>
      {props.rangeInBar ? null : (
        <ItemGroup header="none" surface="none">
          <MachineVitalsRangeBar freshness={freshness} showRange={view.kind === 'ready'} />
        </ItemGroup>
      )}
      {view.kind === 'loading' ? (
        <VitalsLoadingSheet />
      ) : (
        <ArrivalFade enabled={startedLoading}>
          <VitalsSheet testID="machine-vitals-sheet">
            <CpuTile
              sample={view.sample}
              host={published?.host ?? null}
              timeline={timeline}
              axis={resolveVitalsAxis(
                range,
                timeline,
                view.freshness === 'live',
              )}
              freshness={view.freshness}
              live={range === '1h'}
            />
            <MemoryTile
              sample={view.sample}
              attention={attention}
              timeline={timeline}
              nowMs={Date.now()}
              axis={resolveVitalsAxis(
                range,
                timeline,
                view.freshness === 'live',
              )}
              freshness={view.freshness}
              live={range === '1h'}
            />
            <DiskTile sample={view.sample} attention={attention} happierBytesByVolume={happierBytesByVolume} />
            <NetworkTile
              sample={view.sample}
              today={overview.history?.today ?? null}
              timeline={timeline}
              axis={resolveVitalsAxis(
                range,
                timeline,
                view.freshness === 'live',
              )}
              freshness={view.freshness}
              live={range === '1h'}
            />
          </VitalsSheet>
        </ArrivalFade>
      )}
      {view.kind === 'ready' && props.onOpenProcesses ? (
        <MachineUsingTheMost
          serverId={props.serverId}
          machineId={machine.id}
          machineName={props.machineName}
          processes={attribution.processes.answer}
          sample={view.sample}
          logicalCores={published?.host?.logicalCores ?? null}
          onOpenProcesses={props.onOpenProcesses}
        />
      ) : null}
      {view.kind === 'ready' ? (
        <MachineMoreFrom
          machineName={props.machineName}
          extras={selectMachineVitalsExtras(view.sample, overview.samples)}
          attention={attention}
        />
      ) : null}
      <MachineAlertsRow
        serverId={props.serverId}
        machineId={machine.id}
        machineName={props.machineName}
      />
    </>
  );
});

/** The first sample cross-fades in over its reserved boxes; a retained Overview draws at once. */
function ArrivalFade(props: Readonly<{ enabled: boolean; children: React.ReactNode }>) {
  const reducedMotion = useReducedMotionPreference();
  const fade = props.enabled && !reducedMotion;
  const opacity = useSharedValue(fade ? 0 : 1);
  React.useEffect(() => {
    if (fade) opacity.value = withTiming(1, { duration: ARRIVAL_FADE_MS });
  }, [fade, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={style}>{props.children}</Animated.View>;
}

/** Loading (OS 1): the four tiles at their final size with reserved blocks for values and charts. */
function VitalsLoadingSheet() {
  const { theme } = useUnistyles();
  const color = theme.colors.border.default;
  const block = (width: number | `${number}%`, height: number) => (
    <HappierSkeletonBlock color={color} width={width} height={height} />
  );
  const tile = (key: string, label: string, chart: boolean, meters: number) => (
    <VitalsTile
      key={key}
      label={label}
      value={block(64, 22)}
      sub={block(140, 10)}
    >
      {chart ? block('100%', HAPPIER_DATA_METRICS.plotHeightPx + 20) : null}
      {Array.from({ length: meters }, (_, index) => (
        <View key={index} style={styles.loadingMeter}>
          {block('100%', 4)}
        </View>
      ))}
    </VitalsTile>
  );
  return (
    <View
      aria-busy
      accessibilityLabel={t('machineVitals.loading')}
      testID="machine-vitals-loading"
    >
      <VitalsSheet>
        {tile('cpu', t('machineVitals.cpu.title'), true, 0)}
        {tile('memory', t('machineVitals.memory.title'), true, 1)}
        {tile('disk', t('machineVitals.disk.title'), false, 2)}
        {tile('network', t('machineVitals.network.title'), true, 0)}
      </VitalsSheet>
    </View>
  );
}

/**
 * OS 3, 5 and 6 when there is nothing to draw: one state card that names the cause and the ways forward.
 * Offline with nothing read: a quiet line (the page's offline banner already says what it blocks).
 */
function MachineVitalsStateCard(
  props: Readonly<{
    view: Extract<
      MachineVitalsOverviewView,
      { kind: 'older_happier' | 'unavailable' | 'offline_empty' }
    >;
    serverId: string;
    machine: Machine;
    machineName: string;
    onRetry: () => void;
  }>,
) {
  const router = useRouter();
  const door = useMachinesDoor();
  const { view, machineName } = props;
  const openDoctor = React.useCallback(() => {
    router.push(
      machinePageHref({
        door,
        target: { machineId: props.machine.id, serverId: props.serverId },
        page: 'doctor',
      }) as never,
    );
  }, [door, props.machine.id, props.serverId, router]);
  if (view.kind === 'offline_empty') {
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="machine-vitals-offline-empty"
          kind="unavailable"
          size="line"
          title={t('machineVitals.states.offlineEmpty', {
            machine: machineName,
          })}
        />
      </ItemGroup>
    );
  }
  if (view.kind === 'older_happier') {
    const shared = props.machine.isShared === true;
    return (
      <ItemGroup header="none">
        <SurfaceStateCard
          testID="machine-vitals-older"
          size="details"
          kind="empty"
          title={t('machineVitals.states.olderTitle', { machine: machineName })}
          reason={t('machineVitals.states.olderReason', {
            machine: machineName,
          })}
          {...(shared
            ? {
                action: {
                  label: t('machineVitals.states.askOwner', {
                    machine: machineName,
                  }),
                  testID: 'machine-vitals-ask-owner',
                  onPress: () =>
                    setClipboardStringSafe(
                      t('machineVitals.states.askOwnerMessage', {
                        machine: machineName,
                      }),
                    ),
                },
              }
            : {})}
        />
      </ItemGroup>
    );
  }
  const title =
    view.reason === 'helper_missing'
      ? t('machineVitals.states.helperMissingTitle', { machine: machineName })
      : view.since !== null
        ? t('machineVitals.states.stoppedAt', {
            machine: machineName,
            time: formatAsOfTime(view.since),
          })
        : view.reason === 'request_failed'
          ? t('machineVitals.states.unreachableTitle', { machine: machineName })
          : t('machineVitals.states.unreadableTitle', { machine: machineName });
  return (
    <ItemGroup header="none">
      <SurfaceStateCard
        testID="machine-vitals-error"
        size="details"
        kind="error"
        title={title}
        reason={
          view.reason === 'helper_missing'
            ? t('machineVitals.states.helperMissingReason')
            : view.reason === 'request_failed'
              ? t('machineVitals.states.unreachableReason')
              : t('machineVitals.states.unreadableReason')
        }
        diagnosticCode={view.errorCode ?? view.reason}
        {...(view.reason === 'helper_missing'
          ? {}
          : {
              action: {
                label: t('machineVitals.states.tryAgain'),
                onPress: props.onRetry,
                testID: 'machine-vitals-try-again',
              },
            })}
        secondaryAction={{
          label: t('machineVitals.states.openDoctor'),
          onPress: openDoctor,
          testID: 'machine-vitals-open-doctor',
        }}
      />
    </ItemGroup>
  );
}

const styles = StyleSheet.create(() => ({
  loadingMeter: {
    paddingTop: 12,
  },
}));
