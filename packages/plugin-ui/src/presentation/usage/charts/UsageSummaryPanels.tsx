import type { ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../../environment/types.js';
import { useOptionalHappierUiTypography } from '../../../environment/context.js';
import { HAPPIER_SPACE_STEPS } from '../../../environment/spacing.js';
import { HappierBadge } from '../../content/Foundation.js';
import { HappierDataRows } from '../../data/DataRows.js';
import { HappierDataMetric, type HappierDataMetricProps } from '../../data/Metric.js';
import type { HappierStyleProp } from '../../portableTypes.js';
import { HappierText } from '../../text/Text.js';
import { resolveHappierTypeRoleStyle } from '../../text/typeRole.js';

/** Already admitted and localized facts. No query, cost selection or disclosure policy lives here. */
export type UsageSummaryMetric = Omit<HappierDataMetricProps, 'theme' | 'size' | 'showLabel' | 'testID'> & Readonly<{ id: string }>;
export type UsagePeriodSummaryBodyProps = Readonly<{
  theme: HappierUiTheme;
  hero?: UsageSummaryMetric;
  stats: readonly UsageSummaryMetric[];
  subline?: string;
  sublineStyle?: HappierStyleProp;
  /** Host density projection; unhosted presentations use the shared comfortable steps. */
  spacing?: Readonly<{ body: number; statColumns: number; statRows: number }>;
  /** Host-owned freshness/retry control; the body owns the surrounding presentation. */
  coverage?: ReactNode;
  testID?: string;
}>;

/** The original period summary, shared by private Usage and independently admitted public facts. */
export function UsagePeriodSummaryBody(props: UsagePeriodSummaryBodyProps) {
  const typography = useOptionalHappierUiTypography();
  return <View style={{ gap: props.spacing?.body ?? HAPPIER_SPACE_STEPS.s20 }} testID={props.testID ? `${props.testID}.summary` : undefined}>
    {props.hero ? <View style={{ gap: 2 }}>
      <HappierDataMetric {...props.hero} testID={props.testID ? `${props.testID}.hero` : undefined} theme={props.theme} size="hero" />
      {!props.hero.comparison && props.subline !== undefined
        ? <HappierText style={props.sublineStyle ?? { ...resolveHappierTypeRoleStyle('micro', props.theme, typography), color: props.theme.colors.mutedText }}>{props.subline}</HappierText> : null}
    </View> : null}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: props.spacing?.statColumns ?? HAPPIER_SPACE_STEPS.s24,
      rowGap: props.spacing?.statRows ?? HAPPIER_SPACE_STEPS.s16 }}>
      {props.stats.map((stat, index) => <View key={stat.id} style={{ flexGrow: index === 0 ? 2 : 1, flexBasis: index === 0 ? 168 : 100, minWidth: 0 }}>
        <HappierDataMetric {...stat} theme={props.theme} size="stat" showLabel />
      </View>)}
    </View>
    {props.coverage}
  </View>;
}

export type UsageFootprintLabels = Readonly<{
  title: string; reason: string; noEstimate: string; accounted: string; tokensUnit: string;
  proxy: string; proxyDetail: string; methodTitle: string; methodBody: string;
}>;
export type UsageFootprintBodyProps = Readonly<{
  theme: HappierUiTheme;
  labels: UsageFootprintLabels;
  /** Absent when token disclosure is not admitted; footprint consent alone does not disclose it. */
  accountedTokens?: string;
  badgeColor?: string;
  badgeBackgroundColor?: string;
  textStyles?: Readonly<{ title?: HappierStyleProp; reason?: HappierStyleProp; methodTitle?: HappierStyleProp }>;
  /** Host density projection for the heading row and tightly grouped copy. */
  spacing?: Readonly<{ head: number; detail: number }>;
  coverage?: ReactNode;
  testID?: string;
}>;

/** An estimate is unavailable until the canonical method owner has a sufficient basis. */
export function UsageFootprintBody(props: UsageFootprintBodyProps) {
  const labels = props.labels;
  const typography = useOptionalHappierUiTypography();
  const reasonStyle = props.textStyles?.reason ?? { ...resolveHappierTypeRoleStyle('body', props.theme, typography), color: props.theme.colors.secondaryText };
  return <View style={{ gap: 18, minWidth: 0 }} testID={props.testID ? `${props.testID}.footprint` : undefined}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: props.spacing?.head ?? HAPPIER_SPACE_STEPS.s12 }}>
      <View style={{ flex: 1, minWidth: 0, gap: props.spacing?.detail ?? HAPPIER_SPACE_STEPS.s4 }}>
        <HappierText style={props.textStyles?.title ?? { ...resolveHappierTypeRoleStyle('heading', props.theme, typography), color: props.theme.colors.text }} testID={props.testID ? `${props.testID}.status` : undefined}>
          {labels.title}
        </HappierText>
        <HappierText style={reasonStyle}>{labels.reason}</HappierText>
      </View>
      <HappierBadge color={props.badgeColor ?? props.theme.colors.secondaryText} backgroundColor={props.badgeBackgroundColor ?? props.theme.colors.control}>
        <HappierText style={{ ...resolveHappierTypeRoleStyle('micro', props.theme, typography), color: props.badgeColor ?? props.theme.colors.secondaryText }}>
          {labels.noEstimate}
        </HappierText>
      </HappierBadge>
    </View>
    {props.accountedTokens !== undefined ? <HappierDataMetric theme={props.theme}
      testID={props.testID ? `${props.testID}.tokens` : undefined} label={labels.accounted} value={props.accountedTokens} unit={labels.tokensUnit}
      comparison={{ value: labels.proxy, label: labels.proxyDetail, meaning: 'neutral' }} /> : null}
    <View style={{ gap: props.spacing?.detail ?? HAPPIER_SPACE_STEPS.s4 }}>
      <HappierText style={props.textStyles?.methodTitle ?? { ...resolveHappierTypeRoleStyle('body', props.theme, typography, 'semiBold'), color: props.theme.colors.text }}>{labels.methodTitle}</HappierText>
      <HappierText style={reasonStyle}>{labels.methodBody}</HappierText>
    </View>
    {props.coverage}
  </View>;
}

export type UsageSourceCoverageRow = Readonly<{ title: string; label: string; count?: number }>;
export type UsageSourceCoverageBodyProps = Readonly<{
  theme: HappierUiTheme; label: string; columns: readonly [string, string]; rows: readonly UsageSourceCoverageRow[];
  /** Empty state and private controls remain host-owned; populated source/status markup is shared. */
  empty?: ReactNode; showAll?: ReactNode; detail?: ReactNode; testID?: string;
}>;

export function UsageSourceCoverageBody(props: UsageSourceCoverageBodyProps) {
  return <View testID={props.testID ? `${props.testID}.facts` : undefined}>
    {props.rows.length ? <>
      <HappierDataRows theme={props.theme} testID={props.testID ? `${props.testID}.rows` : undefined} label={props.label}
        columns={props.columns.map(label => ({ label }))}
        rows={props.rows.map(row => [(row.count ?? 1) > 1 ? `${row.title} ×${row.count}` : row.title, row.label])} />
      {props.showAll}
    </> : props.empty}
    {props.detail}
  </View>;
}
