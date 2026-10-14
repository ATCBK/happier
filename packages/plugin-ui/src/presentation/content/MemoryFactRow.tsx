import type { ComponentType, ReactNode } from 'react';
import { View } from 'react-native';

import { HappierListItem } from '../collection/List.js';
import type { HappierTextHostProps } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';

export type HappierMemoryFactItemProps = Readonly<{
  testID: string;
  text: string;
  subtitle: ReactNode;
  subtitleText: string;
  archived: boolean;
  retired: boolean;
  actions?: ReactNode;
}>;

type MemoryTextProps = Pick<HappierTextHostProps, 'children' | 'testID' | 'accessibilityRole' | 'accessibilityLabel' | 'onPress'>;

/** Core binds its existing Item and scaled text; authors use the mounted environment. */
export type HappierMemoryFactRowHost = Readonly<{
  Row: ComponentType<HappierMemoryFactItemProps>;
  Metadata: ComponentType<MemoryTextProps>;
  Source: ComponentType<MemoryTextProps>;
}>;

export type HappierMemoryFactRowProps = Readonly<{
  testID: string;
  text: string;
  /** Caller-formatted date, expiry and authorship; this renderer has no clock or reader. */
  metadata: string;
  source?: Readonly<{
    label: string;
    accessibilityLabel: string;
    onPress?: () => void;
  }>;
  archived?: boolean;
  expired?: boolean;
  actions?: ReactNode;
  /** Caller-owned arrival feedback, with its existing animation lifetime. */
  arrival?: ReactNode;
  host?: HappierMemoryFactRowHost;
}>;

function DefaultRow(props: HappierMemoryFactItemProps) {
  return <HappierListItem testID={props.testID} title={props.text}
    titleContent={props.retired ? <HappierText tone="muted" style={{ textDecorationLine: 'line-through' }}
      numberOfLines={props.archived ? undefined : 2}>{props.text}</HappierText> : undefined}
    titleNumberOfLines={props.archived ? 0 : 2}
    subtitle={props.subtitleText}
    subtitleContent={typeof props.subtitle === 'string' ? undefined : props.subtitle}
    subtitleNumberOfLines={1} accessory={props.actions} />;
}

const defaultHost: HappierMemoryFactRowHost = {
  Row: DefaultRow,
  Metadata: props => <HappierText {...props} variant="micro" tone="muted" numberOfLines={1} tabularNumbers />,
  Source: props => <HappierText {...props} variant="micro" tone="secondary" />,
};

/** Controlled memory fact anatomy shared by host documents and plugin-owned fact lists. */
export function HappierMemoryFactRow(props: HappierMemoryFactRowProps): ReactNode {
  const { Row, Metadata, Source } = props.host ?? defaultHost;
  const source = props.source;
  const subtitleText = [props.metadata, source?.label].filter(Boolean).join(' · ');
  const subtitle = source?.onPress ? <Metadata>
    {props.metadata ? `${props.metadata} · ` : ''}
    <Source testID={`${props.testID}.source`} accessibilityRole="link"
      accessibilityLabel={source.accessibilityLabel} onPress={source.onPress}>{source.label}</Source>
  </Metadata> : subtitleText;
  return <View>
    {props.arrival}
    <Row testID={props.testID} text={props.text} subtitle={subtitle} subtitleText={subtitleText}
      archived={props.archived === true} retired={props.archived === true || props.expired === true}
      actions={props.actions} />
  </View>;
}
