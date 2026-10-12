import type { ComponentType, ReactNode } from 'react';
import { View } from 'react-native';

import { useOptionalHappierUiTheme } from '../../environment/context.js';
import { HappierListItem } from '../collection/List.js';
import { HAPPIER_COLLECTION_LIST_METRICS } from '../collection/CollectionList.js';
import { HappierToggle } from '../form/Fields.js';
import { HappierText } from '../text/Text.js';
import type { HappierStyleProp, HappierTextHostProps } from '../portableTypes.js';
import type { HappierWorkStatusTone } from './workStatus.js';

/** Finite row facts; bindings retain the incumbent Item/column and platform switch owners. */
export type HappierTriggerRowBodyProps = Readonly<{
  testID: string;
  title: string;
  subtitle: ReactNode;
  subtitleText: string;
  accessibilityLabel?: string;
  icon?: ReactNode;
  enabled: boolean;
  attention: boolean;
  multiline?: boolean;
  presentation?: 'sheet' | 'column';
  onPress?: () => void;
  toggle: ReactNode;
}>;

export type HappierTriggerRowToggleProps = Readonly<{
  testID: string;
  value: boolean;
  disabled?: boolean;
  accessibilityLabel: string;
  onValueChange: (next: boolean) => void;
}>;

export type HappierTriggerRowHost = Readonly<{
  Row: ComponentType<HappierTriggerRowBodyProps>;
  Toggle: ComponentType<HappierTriggerRowToggleProps>;
  Text: ComponentType<Pick<HappierTextHostProps, 'children' | 'testID'> & Readonly<{ tone: HappierWorkStatusTone }>>;
  actionsStyle?: HappierStyleProp;
}>;

export type HappierTriggerRowProps = Readonly<{
  testID: string;
  title: string;
  /** Already qualified/localized by the caller, including Off or review attention. */
  qualifier?: string | null;
  qualifierAccessibilityLabel?: string;
  outcome?: Readonly<{ text: string; tone: HappierWorkStatusTone }> | null;
  attention?: boolean;
  enabled: boolean;
  toggleDisabled?: boolean;
  toggleLabel: string;
  onToggle: (next: boolean) => void;
  onPress?: () => void;
  multiline?: boolean;
  presentation?: 'sheet' | 'column';
  icon?: ReactNode;
  actions?: ReactNode;
  /** Core's theme/text/row binding; ordinary plugin surfaces use the mounted environment. */
  host?: HappierTriggerRowHost;
}>;

function DefaultRow(props: HappierTriggerRowBodyProps) {
  return <HappierListItem testID={props.testID} title={props.title}
    titleContent={!props.enabled && !props.attention ? <HappierText variant="label" tone="muted">{props.title}</HappierText> : undefined}
    subtitle={props.subtitleText || undefined}
    subtitleContent={props.subtitle ? <HappierText variant="micro" tone={props.attention ? 'attention' : props.enabled ? 'secondary' : 'muted'}>{props.subtitle}</HappierText> : undefined}
    accessibilityLabel={props.accessibilityLabel}
    icon={props.icon} onPress={props.onPress} accessory={props.toggle} accessoryOutsidePressable
    titleNumberOfLines={props.multiline ? 0 : 1} subtitleNumberOfLines={props.multiline ? 0 : 2}
    density={props.presentation === 'column' ? 'compact' : undefined} showDivider={false} />;
}

function DefaultToggle(props: HappierTriggerRowToggleProps) {
  const theme = useOptionalHappierUiTheme();
  if (!theme) throw new Error('TriggerRow requires a mounted theme or a host binding.');
  return <HappierToggle label={props.accessibilityLabel} value={props.value} disabled={props.disabled}
    onChange={props.onValueChange} theme={theme} testID={props.testID} />;
}

const defaultHost: HappierTriggerRowHost = {
  Row: DefaultRow,
  Toggle: DefaultToggle,
  Text: ({ tone, ...props }) => <HappierText {...props} variant="micro" tone={tone === 'neutral' ? 'muted' : tone} />,
};

/** One trigger's presentation; schedules, clocks, source reads and writes remain caller-owned. */
export function HappierTriggerRow(props: HappierTriggerRowProps) {
  const { Row, Toggle, Text, actionsStyle } = props.host ?? defaultHost;
  const lead = props.qualifier;
  const outcome = props.outcome;
  const line = [lead, outcome?.text].filter(Boolean).join(' · ');
  const subtitle = outcome ? <Text tone="neutral">
    {lead ? `${lead} · ` : ''}<Text testID={`${props.testID}-outcome`} tone={outcome.tone}>{outcome.text}</Text>
  </Text> : lead;
  const toggle = <Toggle testID={`${props.testID}-switch`} value={props.enabled} disabled={props.toggleDisabled}
    accessibilityLabel={props.toggleLabel} onValueChange={props.onToggle} />;
  // A row with its own actions line (History · Run now) ends that line with the switch, the pause, so the
  // title and its quiet line keep the whole row width (lab `b-habit T`).
  const toggleOnActions = Boolean(props.actions) && props.presentation !== 'column';
  return <>
    <Row testID={props.testID} title={props.title} subtitle={subtitle} subtitleText={line}
      accessibilityLabel={props.qualifierAccessibilityLabel
        ? [props.title, lead, props.qualifierAccessibilityLabel, outcome?.text].filter(Boolean).join('. ')
        : undefined}
      enabled={props.enabled} attention={props.attention === true} multiline={props.multiline}
      presentation={props.presentation} icon={props.icon} onPress={props.onPress} toggle={toggleOnActions ? null : toggle} />
    {props.actions ? <View testID={`${props.testID}-actions`} style={actionsStyle ?? {
      flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap',
      paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset,
    }}>{props.actions}{toggleOnActions ? toggle : null}</View> : null}
  </>;
}
