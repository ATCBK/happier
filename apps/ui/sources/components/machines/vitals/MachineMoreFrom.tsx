import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MachineResourceAttentionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';

import { resolveMachineResourceToneColor } from '@/components/machines/summary/machineSummaryStripModel';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useDeviceType } from '@/utils/platform/responsive';

import {
  formatMachineBytes,
  resolveLimitTone,
  type MachineVitalsExtras,
} from './machineVitalsPresentation';
import { formatVitalsPercent } from './vitalsFormat';

type Fact = Readonly<{
  key: string;
  label: string;
  value: string;
  detail: string | null;
}>;

const THERMAL_KEYS = {
  nominal: 'machineVitals.more.thermal.nominal',
  fair: 'machineVitals.more.thermal.fair',
  serious: 'machineVitals.more.thermal.serious',
  critical: 'machineVitals.more.thermal.critical',
} as const;

const LIMIT_KEYS = {
  files: 'machineVitals.more.limits.files',
  ptys: 'machineVitals.more.limits.ptys',
  processes: 'machineVitals.more.limits.processes',
  inotify: 'machineVitals.more.limits.inotify',
} as const;

function durationWords(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours === 0) return t('machineVitals.more.minutes', { minutes: rest });
  return rest === 0
    ? t('machineVitals.more.hours', { hours })
    : t('machineVitals.more.hoursMinutes', { hours, minutes: rest });
}

/** The facts this machine reports beyond the four vitals, in a fixed order; anything it cannot give is left out. */
export function buildMachineMoreFromFacts(
  extras: MachineVitalsExtras,
): readonly Fact[] {
  const facts: Fact[] = [];
  const battery = extras.battery;
  if (battery) {
    const detail =
      battery.state === 'full'
        ? t('machineVitals.more.battery.full')
        : battery.state === 'charging'
          ? battery.minutesToFull !== undefined
            ? t('machineVitals.more.battery.chargingUntil', {
                duration: durationWords(battery.minutesToFull),
              })
            : t('machineVitals.more.battery.charging')
          : battery.minutesToEmpty !== undefined
            ? t('machineVitals.more.battery.left', {
                duration: durationWords(battery.minutesToEmpty),
              })
            : t('machineVitals.more.battery.onBattery');
    facts.push({
      key: 'battery',
      label: t('machineVitals.more.battery.title'),
      value: `${formatVitalsPercent(battery.pct)}%`,
      detail,
    });
  }
  const gpus = extras.gpu ?? [];
  if (gpus.length > 0) {
    const first = gpus[0]!;
    const sameModel = gpus.every((gpu) => gpu.name === first.name);
    const awake = gpus.filter((gpu) => gpu.powerState !== 'off');
    const off = gpus.filter((gpu) => gpu.powerState === 'off');
    const busy = awake.flatMap((gpu) =>
      gpu.busyPct === undefined ? [] : [gpu.busyPct],
    );
    const used = gpus.reduce((sum, gpu) => sum + (gpu.memUsedBytes ?? 0), 0);
    const total = gpus.reduce((sum, gpu) => sum + (gpu.memTotalBytes ?? 0), 0);
    const totalReported = off.length === 0 && gpus.every((gpu) => gpu.memTotalBytes !== undefined);
    const usedReported = gpus.every((gpu) => gpu.memUsedBytes !== undefined);
    const name =
      gpus.length === 1
        ? first.name
        : sameModel
          ? t('machineVitals.more.gpu.several', {
              count: gpus.length,
              name: first.name,
            })
          : t('machineVitals.more.gpu.andMore', {
              name: first.name,
              count: gpus.length - 1,
            });
    const detail = [
      name,
      awake.length > 0 ? off.map((gpu) => `${gpu.name}: ${t('common.off')}`).join(' · ') || null : null,
      gpus.length === 1 && first.cores !== undefined
        ? t('machineVitals.more.gpu.cores', { count: first.cores })
        : null,
      totalReported && total > 0
        ? t('machineVitals.more.gpu.memory', {
            used: usedReported ? formatMachineBytes(used, 'memory') : t('machineVitals.unmeasured'),
            total: formatMachineBytes(total, 'memory'),
          })
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
    facts.push({
      key: 'gpu',
      label: t('machineVitals.more.gpu.title'),
      value:
        awake.length === 0
          ? t('common.off')
          : busy.length > 0
            ? `${formatVitalsPercent(busy.reduce((sum, value) => sum + value, 0) / busy.length)}%`
            : t('machineVitals.unmeasured'),
      detail,
    });
  }
  const thermal = extras.thermal;
  if (thermal?.state) {
    facts.push({
      key: 'thermal',
      label: t('machineVitals.more.thermal.title'),
      value: t(THERMAL_KEYS[thermal.state]),
      detail: thermal.throttled === undefined ? null : thermal.throttled
        ? t('machineVitals.more.thermal.throttled')
        : t('machineVitals.more.thermal.notThrottled'),
    });
  } else if (thermal?.tempC !== undefined) {
    facts.push({
      key: 'temperature',
      label: t('machineVitals.more.temperature.title'),
      value: t('machineVitals.more.temperature.value', {
        degrees: Math.round(thermal.tempC),
      }),
      detail:
        [
          thermal.sensor && /(?:package|cpu|pkg|tctl|tdie)/iu.test(thermal.sensor)
            ? t('machineVitals.cpu.title')
            : null,
          thermal.fanPct !== undefined
            ? t('machineVitals.more.temperature.fans', {
                percent: Math.round(thermal.fanPct),
              })
            : null,
          thermal.throttled ? t('machineVitals.more.thermal.throttled') : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
    });
  } else if (thermal?.throttled === true) {
    facts.push({ key: 'thermal', label: t('machineVitals.more.thermal.title'),
      value: t('machineVitals.more.thermal.throttled'), detail: null });
  }
  const shm = extras.sharedMemory;
  if (shm) {
    facts.push({
      key: 'shm',
      label: t('machineVitals.more.sharedMemory.title'),
      value: formatMachineBytes(shm.availableBytes, 'memory'),
      detail: t('machineVitals.more.sharedMemory.detail', {
        total: formatMachineBytes(shm.totalBytes, 'memory'),
      }),
    });
  }
  return facts;
}

/**
 * "More from <machine>" (lab `rv` O / OE): battery, GPU, thermal state or temperature, shared memory in a
 * container — only what this machine reports, never an empty tile — then the enforced limits it reports
 * (open files, terminals, processes, file watches) as one quiet line; a limit fully used takes the tone.
 */
export const MachineMoreFrom = React.memo(function MachineMoreFrom(
  props: Readonly<{
    machineName: string;
    extras: MachineVitalsExtras;
    attention: MachineResourceAttentionV1 | null;
  }>,
) {
  const language = usePreferredLanguage();
  const { theme } = useUnistyles();
  const phone = useDeviceType() === 'phone';
  const facts = React.useMemo(
    () => buildMachineMoreFromFacts(props.extras),
    [language, props.extras],
  );
  const limits = props.extras.limits;
  const limitEntries = limits
    ? (['files', 'ptys', 'processes', 'inotify'] as const).flatMap((key) => {
        const limit = limits[key];
        if (!limit) return [];
        const values = { name: t(LIMIT_KEYS[key]), used: limit.used.toLocaleString() };
        return [
          {
            key,
            // The signed/unsigned 64-bit kernel infinity sentinels round to these JSON numbers.
            value: limit.max === 2 ** 63 || limit.max === 2 ** 64
              ? t('machineVitals.more.limits.unlimitedEntry', values)
              : t('machineVitals.more.limits.entry', { ...values, max: limit.max.toLocaleString() }),
            tone: resolveLimitTone(props.attention, key),
          },
        ];
      })
    : [];
  if (facts.length === 0 && limitEntries.length === 0) return null;
  return (
    <ItemGroup
      title={t('machineVitals.more.title', { machine: props.machineName })}
      titleAccessory={
        <Text style={styles.titleNote}>{t('machineVitals.more.reported')}</Text>
      }
    >
      <View testID="machine-vitals-more">
        {facts.length > 0 ? (
          <View style={phone ? null : styles.cells}>
            {facts.map((fact, index) =>
              phone ? (
                <View
                  key={fact.key}
                  accessible
                  accessibilityLabel={[fact.label, fact.value, fact.detail]
                    .filter(Boolean)
                    .join(', ')}
                  style={[
                    styles.phoneRow,
                    index > 0 ? styles.rowDivider : null,
                  ]}
                >
                  <View style={styles.phoneText}>
                    <Text numberOfLines={1} style={styles.label}>
                      {fact.label}
                    </Text>
                    {fact.detail ? (
                      <Text numberOfLines={1} style={styles.detail}>
                        {fact.detail}
                      </Text>
                    ) : null}
                  </View>
                  <Text numberOfLines={1} style={styles.phoneValue}>
                    {fact.value}
                  </Text>
                </View>
              ) : (
                <View
                  key={fact.key}
                  accessible
                  accessibilityLabel={[fact.label, fact.value, fact.detail]
                    .filter(Boolean)
                    .join(', ')}
                  style={[styles.cell, index > 0 ? styles.cellDivider : null]}
                >
                  <Text numberOfLines={1} style={styles.label}>
                    {fact.label}
                  </Text>
                  <Text numberOfLines={1} style={styles.value}>
                    {fact.value}
                  </Text>
                  {fact.detail ? (
                    <Text numberOfLines={1} style={styles.detail}>
                      {fact.detail}
                    </Text>
                  ) : null}
                </View>
              ),
            )}
          </View>
        ) : null}
        {limitEntries.length > 0 ? (
          <View
            style={[styles.limits, facts.length > 0 ? styles.rowDivider : null]}
            testID="machine-vitals-limits"
            accessible
            accessibilityLabel={limitEntries
              .map((entry) => entry.value)
              .join(', ')}
          >
            <Text style={styles.label}>
              {t('machineVitals.more.limits.title')}
            </Text>
            <Text style={styles.limitsText}>
              {limitEntries.map((entry, index) => (
                <Text
                  key={entry.key}
                  style={
                    entry.tone === 'calm'
                      ? null
                      : {
                          color: resolveMachineResourceToneColor(
                            entry.tone,
                            theme.colors,
                          ),
                        }
                  }
                >
                  {index > 0 ? ' · ' : ''}
                  {entry.value}
                </Text>
              ))}
            </Text>
          </View>
        ) : null}
      </View>
    </ItemGroup>
  );
});

const styles = StyleSheet.create((theme) => ({
  titleNote: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  cells: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  cell: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s2,
    paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    paddingVertical: PAGE_LIST_METRICS.rowPaddingVerticalPx + 2,
  },
  cellDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border.subtle,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    paddingVertical: PAGE_LIST_METRICS.rowPaddingVerticalPx,
  },
  phoneText: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s2,
  },
  label: {
    ...Typography.variant('meta'),
    ...Typography.default('medium'),
    color: theme.colors.text.secondary,
  },
  value: {
    ...Typography.variant('label', 'semiBold'),
    ...Typography.tabular(),
    color: theme.colors.text.primary,
  },
  phoneValue: {
    ...Typography.variant('meta'),
    ...Typography.default('medium'),
    ...Typography.tabular(),
    color: theme.colors.text.primary,
  },
  detail: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  limits: {
    gap: theme.space.s2,
    paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    paddingVertical: PAGE_LIST_METRICS.rowPaddingVerticalPx,
  },
  limitsText: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
  },
}));
