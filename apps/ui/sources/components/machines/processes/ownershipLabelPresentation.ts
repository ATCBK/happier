import type { ProcessOwnershipLevelV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';

import type { IconName } from '@/components/ui/icons/Icon';
import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import type { TranslationKeyNoParams } from '@/text';

export type OwnershipLabel = Readonly<{
  labelKey: TranslationKeyNoParams;
  icon: IconName;
  /** The quiet pill's tone (glyph + word, no fill). */
  variant: StatusPillVariant;
}>;

/**
 * The one kind → label table for process ownership (plan 30 PROC-17, R14): a row says how Happier knows it
 * started it only when that is not proven. Plans 50 and 60 import this table; nobody draws their own label.
 */
const LABELS: Readonly<
  Record<Exclude<ProcessOwnershipLevelV1, 'proven'>, OwnershipLabel>
> = {
  likely: {
    labelKey: 'machineProcesses.ownership.likely',
    icon: 'shield',
    variant: 'neutral',
  },
  left_behind: {
    labelKey: 'machineProcesses.ownership.leftBehind',
    icon: 'clock-counter-clockwise',
    variant: 'attention',
  },
  not_happier: {
    labelKey: 'machineProcesses.ownership.notHappiers',
    icon: 'minus-circle',
    variant: 'neutral',
  },
  unknown: {
    labelKey: 'machineProcesses.ownership.unknown',
    icon: 'question',
    variant: 'neutral',
  },
};

export function resolveOwnershipLabel(
  level: ProcessOwnershipLevelV1,
): OwnershipLabel | null {
  return level === 'proven' ? null : LABELS[level];
}
