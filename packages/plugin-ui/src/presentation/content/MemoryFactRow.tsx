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
  /** Opens the fact's own detail (its reason, source, approval and history). */
  onPress?: () => void;
  /** The fact whose detail is open beside the list. */
  selected?: boolean;
}>;

type MemoryTextProps = Pick<HappierTextHostProps, 'children' | 'testID' | 'accessibilityRole' | 'accessibilityLabel' | 'onPress'>;

/** Core binds its existing Item and scaled text; authors use the mounted environment. */
export type HappierMemoryFactRowHost = Readonly<{
  Row: ComponentType<HappierMemoryFactItemProps>;
  Metadata: ComponentType<MemoryTextProps>;
  Source: ComponentType<MemoryTextProps>;
  /** A fact's own explanation (a decision's reason), up to two lines above the metadata. */
  Detail?: ComponentType<MemoryTextProps>;
}>;

export type HappierMemoryFactRowProps = Readonly<{
  testID: string;
  text: string;
  /** Caller-formatted date, expiry and authorship; this renderer has no clock or reader. */
  metadata: string;
  /** Caller-owned explanation of the fact (a decision's reason), on its own line above the metadata. */
  detail?: string;
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
  /** Opens the fact's detail; without it the row is read in place. */
  onPress?: () => void;
  selected?: boolean;
  host?: HappierMemoryFactRowHost;
}>;

function DefaultRow(props: HappierMemoryFactItemProps) {
  return <HappierListItem testID={props.testID} title={props.text}
    titleContent={props.retired ? <HappierText tone="muted" style={{ textDecorationLine: 'line-through' }}
      numberOfLines={props.archived ? undefined : 2}>{props.text}</HappierText> : undefined}
    titleNumberOfLines={props.archived ? 0 : 2}
    subtitle={props.subtitleText}
    subtitleContent={typeof props.subtitle === 'string' ? undefined : props.subtitle}
    subtitleNumberOfLines={1} accessory={props.actions}
    onPress={props.onPress} selected={props.selected} />;
}

const defaultHost: HappierMemoryFactRowHost = {
  Row: DefaultRow,
  Metadata: props => <HappierText {...props} variant="micro" tone="muted" numberOfLines={1} tabularNumbers />,
  Source: props => <HappierText {...props} variant="micro" tone="secondary" />,
  Detail: props => <HappierText {...props} variant="micro" tone="secondary" numberOfLines={2} />,
};

/** Controlled memory fact anatomy shared by host documents and plugin-owned fact lists. */
export function HappierMemoryFactRow(props: HappierMemoryFactRowProps): ReactNode {
  const host = props.host ?? defaultHost;
  const { Row, Metadata, Source } = host;
  const Detail = host.Detail ?? defaultHost.Detail!;
  const source = props.source;
  const metaText = [props.metadata, source?.label].filter(Boolean).join(' · ');
  const meta = source?.onPress ? <Metadata>
    {props.metadata ? `${props.metadata} · ` : ''}
    <Source testID={`${props.testID}.source`} accessibilityRole="link"
      accessibilityLabel={source.accessibilityLabel} onPress={source.onPress}>{source.label}</Source>
  </Metadata> : metaText;
  // A detail gets its own line, so the one-line metadata never truncates the approval or the link away.
  const detail = props.detail?.trim() || null;
  const subtitleText = [detail, metaText].filter(Boolean).join('\n');
  const subtitle = detail ? <View>
    <Detail testID={`${props.testID}.detail`}>{detail}</Detail>
    {typeof meta === 'string' ? <Metadata>{meta}</Metadata> : meta}
  </View> : meta;
  return <View>
    {props.arrival}
    <Row testID={props.testID} text={props.text} subtitle={subtitle} subtitleText={subtitleText}
      archived={props.archived === true} retired={props.archived === true || props.expired === true}
      actions={props.actions} onPress={props.onPress} selected={props.selected} />
  </View>;
}
