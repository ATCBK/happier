import type { ReactElement } from 'react';
import { View } from 'react-native';

import {
  HappierSpinner,
  iconMatchedSpinnerSize,
} from '../presentation/feedback/Spinner.js';
import { HappierStatusDot } from '../presentation/status/StatusDot.js';
import type { HappierIconName } from '../presentation/content/Icon.js';
import { usePluginTheme } from './PluginUiProvider.js';

/**
 * Where an automated check stands: a CI run, job or step, a pull request check, a deployment gate. Forges map their
 * own outcomes onto these (GitHub's `timed_out` is `failed` with its own word; a job whose needs failed is
 * `skipped`). Sources never add another.
 */
export type CheckStatusKind =
  | 'passed'
  | 'failed'
  | 'running'
  | 'queued'
  | 'waiting'
  | 'cancelled'
  | 'skipped'
  | 'neutral'
  | 'unknown';

export type CheckStatusGlyphProps = Readonly<{
  status: CheckStatusKind;
  /** The glyph box in points; a list row's status slot is 16, a page title's 20. */
  size?: number;
  /** Names the glyph when nothing beside it says the status; otherwise it is hidden from assistive technology. */
  accessibilityLabel?: string;
  testID?: string;
}>;

const GLYPH: Readonly<
  Record<Exclude<CheckStatusKind, 'running'>, HappierIconName>
> = Object.freeze({
  passed: 'check',
  failed: 'failure',
  queued: 'waiting',
  waiting: 'review',
  cancelled: 'pause',
  skipped: 'neutral',
  neutral: 'neutral',
  unknown: 'neutral',
});

/**
 * A check's status as a mark. The shape carries the state, never colour alone: a check ring for passed, an alert
 * ring for failed, the activity spinner while it runs, an hourglass while it is queued, a shield while it waits on a
 * person, a stop for cancelled and a level dash for skipped or neutral. Healthy states stay ink; rose is only for a
 * failure and amber only for a check that waits on the person.
 *
 * The glyph shapes are the shared status owner's (`HappierStatusDot`), so a check in a CI log, a pull request and a
 * Work row read the same.
 */
export function CheckStatusGlyph({
  status,
  size = 16,
  accessibilityLabel,
  testID,
}: CheckStatusGlyphProps): ReactElement {
  const theme = usePluginTheme();
  const color =
    status === 'failed'
      ? theme.colors.danger
      : status === 'waiting'
        ? theme.colors.attention
        : status === 'cancelled' || status === 'skipped' || status === 'unknown'
          ? theme.colors.mutedText
          : theme.colors.secondaryText;
  if (status === 'running') {
    return (
      <View
        testID={testID}
        style={{
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        {...(accessibilityLabel
          ? { role: 'img' as const, 'aria-label': accessibilityLabel }
          : { 'aria-hidden': true })}
      >
        <HappierSpinner size={iconMatchedSpinnerSize(size)} color={color} />
      </View>
    );
  }
  return (
    <HappierStatusDot
      glyph={GLYPH[status]}
      color={color}
      size={size}
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}
