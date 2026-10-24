import type { MachineVitalsAlertsPolicyV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsAlertsV1';

import type { MachineResourcesPolicyReadOnlyReason } from '@/sync/domains/machines/resources/machineResourcesPolicy';
import { parsePolicyDuration } from '@/components/machines/policy/policyDuration';
import { t } from '@/text';

import { formatMachineDuration } from '../durationWords';

import { formatMachineBytes } from './machineVitalsPresentation';

/**
 * The alert rules in words (lab `rv` AL): what each rule waits for, the Alerts row's one-line state, and
 * the choices each select offers. The rules themselves are the machine's resources policy (`alerts`);
 * nothing here stores or evaluates them.
 */

export type MachineDiskThreshold =
  MachineVitalsAlertsPolicyV1['disk']['threshold'];

const DAY_MINUTES = 1440;

/** "5 min", "1 h", "2 h 30 min", "2 d": a sustain as a person says it (the one machine duration wording). */
export const formatAlertSustain = formatMachineDuration;

/** "10%", "20 GB": the disk line, as a share or an amount (plan 20 D5). */
export function formatDiskThreshold(threshold: MachineDiskThreshold): string {
  return 'freeFraction' in threshold
    ? t('machineVitals.alerts.percent', {
        percent: Math.round(threshold.freeFraction * 1000) / 10,
      })
    : formatMachineBytes(threshold.freeBytes, 'storage');
}

export function formatCpuThreshold(abovePct: number): string {
  return t('machineVitals.alerts.percent', { percent: abovePct });
}

/** What a rule waits for, said while it is off ("When memory pressure stays critical for 5 min"). */
export function describeAlertRule(
  rule: 'memory' | 'disk' | 'cpu',
  alerts: MachineVitalsAlertsPolicyV1,
): string {
  if (rule === 'memory') {
    return t(
      alerts.memory.level === 'critical'
        ? 'machineVitals.alerts.memory.ruleCritical'
        : 'machineVitals.alerts.memory.ruleElevated',
      { sustain: formatAlertSustain(alerts.memory.sustainMs) },
    );
  }
  if (rule === 'disk')
    return t('machineVitals.alerts.disk.rule', {
      threshold: formatDiskThreshold(alerts.disk.threshold),
    });
  return t('machineVitals.alerts.cpu.rule', {
    threshold: formatCpuThreshold(alerts.cpu.abovePct),
    sustain: formatAlertSustain(alerts.cpu.sustainMs),
  });
}

const RULE_NAME_KEYS = {
  memory: 'machineVitals.alerts.names.memory',
  disk: 'machineVitals.alerts.names.disk',
  cpu: 'machineVitals.alerts.names.cpu',
} as const;

/**
 * The Alerts row's one line (lab `rv` O / OE): off and what turning one on gives, the one rule that is on
 * in full, or the rules that are on by name. A recipient's row says who sets them (plan 20 D1).
 */
export function describeMachineAlertsRow(
  input: Readonly<{
    machineName: string;
    alerts: MachineVitalsAlertsPolicyV1 | null;
    readOnlyReason: MachineResourcesPolicyReadOnlyReason;
  }>,
): string {
  if (input.readOnlyReason === 'not_custodian')
    return t('machineVitals.alerts.row.setByOwner', {
      machine: input.machineName,
    });
  if (!input.alerts) return t('machineVitals.alerts.row.unreadable');
  const on = (['memory', 'disk', 'cpu'] as const).filter(
    (rule) => input.alerts![rule].enabled,
  );
  if (on.length === 0)
    return t('machineVitals.alerts.row.off', { machine: input.machineName });
  if (on.length === 1) {
    const rule = on[0]!;
    return t('machineVitals.alerts.row.onOne', {
      name: t(RULE_NAME_KEYS[rule]),
      rule: describeAlertRuleSentence(rule, input.alerts),
    });
  }
  const names = on.map((rule) => t(RULE_NAME_KEYS[rule]));
  return on.length === 2
    ? t('machineVitals.alerts.row.onTwo', {
        first: names[0]!,
        second: names[1]!,
      })
    : t('machineVitals.alerts.row.onThree', {
        first: names[0]!,
        second: names[1]!,
        third: names[2]!,
      });
}

/** The rule as the second half of "You hear when …". */
function describeAlertRuleSentence(
  rule: 'memory' | 'disk' | 'cpu',
  alerts: MachineVitalsAlertsPolicyV1,
): string {
  if (rule === 'memory') {
    return t(
      alerts.memory.level === 'critical'
        ? 'machineVitals.alerts.memory.whenCritical'
        : 'machineVitals.alerts.memory.whenElevated',
      { sustain: formatAlertSustain(alerts.memory.sustainMs) },
    );
  }
  if (rule === 'disk')
    return t('machineVitals.alerts.disk.when', {
      threshold: formatDiskThreshold(alerts.disk.threshold),
    });
  return t('machineVitals.alerts.cpu.when', {
    threshold: formatCpuThreshold(alerts.cpu.abovePct),
    sustain: formatAlertSustain(alerts.cpu.sustainMs),
  });
}

// ── Choices (plan 20 §4.7, R43) ──────────────────────────────────────────────────────────────────────

/** Sustain presets in minutes; Custom… takes any whole minute up to the week the evaluator can read. */
export const ALERT_SUSTAIN_PRESET_MINUTES = [1, 2, 5, 10, 15, 30, 60] as const;
export const ALERT_SUSTAIN_MAX_MINUTES = 7 * DAY_MINUTES;
export const CPU_THRESHOLD_PRESETS = [70, 75, 80, 85, 90, 95] as const;
export const DISK_FRACTION_PRESETS = [0.05, 0.1, 0.15, 0.2, 0.25] as const;
export const DISK_BYTES_PRESETS = [10e9, 20e9, 50e9, 100e9] as const;

/** A whole number of minutes, one up to a week; anything else is not a sustain. */
export function parseCustomSustainMinutes(raw: string): number | null {
  return parsePolicyDuration(raw, { unit: 'min', minimum: 1, maximum: ALERT_SUSTAIN_MAX_MINUTES });
}

/** A busy line between 1 and 100 percent. */
export function parseCustomCpuPercent(raw: string): number | null {
  const value = Number(raw.trim().replace(/\s*%$/u, ''));
  return Number.isFinite(value) && value >= 1 && value <= 100 ? value : null;
}

/**
 * "15%" or "15" (a share, 0–100 %), "30 GB" / "1.5 TB" (an amount, more than nothing, at most the largest
 * volume when one is known): the disk line as either kind.
 */
export function parseCustomDiskThreshold(
  raw: string,
  largestVolumeBytes: number | null,
): MachineDiskThreshold | null {
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(%|b|kb|mb|gb|tb|pb)?\s*$/iu.exec(raw);
  if (!match) return null;
  const value = Number(match[1]!.replace(',', '.'));
  const unit = (match[2] ?? '%').toLowerCase();
  if (unit === '%')
    return value >= 0 && value <= 100
      ? { freeFraction: Math.round(value * 10) / 1000 }
      : null;
  const scale = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15 }[
    unit as 'b' | 'kb' | 'mb' | 'gb' | 'tb' | 'pb'
  ];
  const bytes = Math.round(value * scale);
  if (bytes <= 0 || !Number.isSafeInteger(bytes)) return null;
  if (largestVolumeBytes !== null && bytes > largestVolumeBytes) return null;
  return { freeBytes: bytes };
}
