import type { ReactElement, ReactNode } from 'react';

import { HappierStatus } from '../presentation/status/Status.js';
import {
  HAPPIER_REVIEW_SEVERITY_TONE,
  HappierReviewSeveritySign,
  type HappierReviewSeverity,
} from '../presentation/status/ReviewSeverity.js';
import { Badge } from './Foundation.js';
import {
  type PluginUiFocusTarget,
  usePluginUiFocusTargetBindingInternal,
} from './Focus.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';
import type { TextTone } from './Text.js';

export type StatusProps = Readonly<{
  /** Semantic meaning, resolved from the host theme. */
  tone: TextTone;
  /**
   * What the status means, in words.
   *
   * Required, and not for symmetry: a colour-only indicator conveys nothing to
   * a screen-reader user or to a user who cannot distinguish the hue. Making
   * the label mandatory removes the invalid state instead of leaving an
   * `accessibilityLabel` prop an author can forget.
   */
  label: string;
  /** A key from this plugin's declared translation bundle; `label` is its fallback. */
  labelKey?: string;
  /**
   * A second, quieter line under the label: the reason or the time ("Loaded 10:42"), so one status can
   * carry the whole answer beside its action instead of a status plus a banner. Notice presentation only.
   */
  value?: string;
  /** A key from this plugin's declared translation bundle; `value` is its fallback. */
  valueKey?: string;
  /**
   * Whether the status is live/in-flight. The host's reduced-motion preference
   * still decides whether the indicator actually animates.
   */
  pulsing?: boolean;
  /** Inline metadata truncates to one line and does not announce row refreshes. */
  presentation?: 'notice' | 'inline';
  /** Quiet states may omit the decorative indicator while retaining their words. */
  indicator?: boolean;
  /** Optional decorative source/agent mark before the status. */
  leading?: ReactNode;
  /** Logical focus target transferred by the mounted host after author state changes. */
  focusTarget?: PluginUiFocusTarget;
  /**
   * The notice's next action, beside the sentence (a plain `Button`, e.g.
   * Retry). The sentence wraps next to it and never truncates.
   */
  action?: ReactNode;
  testID?: string;
}>;

/**
 * A labelled status indicator for plugin surfaces.
 *
 * The shared status row owns its live-region semantics, tone mapping and
 * decorative dot. This adapter resolves only plugin-local copy and theme facts.
 */
export function Status({ tone, label, labelKey, value, valueKey, pulsing, presentation, indicator, leading, focusTarget, action, testID }: StatusProps): ReactElement {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const resolvedLabel = resolveAuthorText(translate, label, labelKey) ?? label;
  const resolvedValue = value === undefined ? undefined : resolveAuthorText(translate, value, valueKey) ?? value;
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);

  return (
    <HappierStatus
      label={resolvedLabel}
      {...(resolvedValue === undefined || presentation === 'inline' ? {} : { value: resolvedValue })}
      tone={tone}
      theme={theme}
      isPulsing={pulsing}
      presentation={presentation}
      indicator={indicator}
      leading={leading}
      controlRef={focusBinding}
      action={action}
      testID={testID}
    />
  );
}

export type ReviewSeverityProps = Readonly<{
  severity: HappierReviewSeverity;
  /** The severity in words ("High"); your translated copy. */
  label: string;
  /** A key from this plugin's declared translation bundle; `label` is its fallback. */
  labelKey?: string;
  /**
   * `label` (default): its dot and word in its colour ("● High"). `badge`: a tinted chip, for a finding
   * listed among other facts. `dot`: the mark alone (a contents row), named by `label`.
   */
  presentation?: 'label' | 'badge' | 'dot';
  testID?: string;
}>;

/**
 * A review finding's severity, drawn the way Happier's own review surfaces draw it: one colour role per
 * severity (`HAPPIER_REVIEW_SEVERITY_TONE`), your words.
 */
export function ReviewSeverity({ severity, label, labelKey, presentation = 'label', testID }: ReviewSeverityProps): ReactElement {
  const theme = usePluginTheme();
  const resolvedLabel = resolveAuthorText(usePluginTranslation(), label, labelKey) ?? label;
  if (presentation === 'badge') {
    return <Badge variant="tinted" tone={HAPPIER_REVIEW_SEVERITY_TONE[severity]} value={resolvedLabel} {...(testID === undefined ? {} : { testID })} />;
  }
  return <HappierReviewSeveritySign severity={severity} label={resolvedLabel} theme={theme} presentation={presentation} {...(testID === undefined ? {} : { testID })} />;
}
