import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import { List } from './List.js';
import { Row, Stack } from './Layout.js';
import { usePluginTheme } from './PluginUiProvider.js';
import { Text } from './Text.js';

/** Content for one point on a timeline; the author owns its meaning and reading order. */
export type TimelineItemContent = Readonly<{
  /** An author-supplied icon or avatar, framed by the timeline's marker. */
  glyph: ReactNode;
  /** Inline text content for the event's sentence. */
  heading: ReactNode;
  /** Inline time content, following the sentence. Formatting stays author-owned. */
  time?: ReactNode;
  /** Content beneath the sentence: a quotation, replies, or event controls. */
  body?: ReactNode;
  /** An independent control at the end of the row, such as opening the event. */
  trailing?: ReactNode;
}>;

export type TimelineProps<Item> = Readonly<{
  /** Already ordered by the author; Timeline never infers chronology or event policy. */
  items: readonly Item[];
  keyForItem: (item: Item, index: number) => string;
  renderItem: (item: Item, index: number) => TimelineItemContent;
  accessibilityLabel?: string;
  accessibilityLabelKey?: string;
  header?: ReactNode;
  empty?: ReactNode;
  /** Content after the stream, scrolling with its rows. */
  endContent?: ReactNode;
  /** Delegates keyed prepend anchoring to the shared List owner. */
  preserveVisibleContentPositionOnPrepend?: boolean;
  testID?: string;
}>;

/** Geometry of the compact event rail; theme tokens own its gaps, typography and ink. */
const TIMELINE_METRICS = Object.freeze({
  markerPx: 24,
  railPx: 1.5,
  rowInsetPx: 7,
  sentenceInsetPx: 3,
});

function TimelineRow({ content, first, last }: Readonly<{
  content: TimelineItemContent;
  first: boolean;
  last: boolean;
}>): ReactElement {
  const theme = usePluginTheme();
  const { markerPx, railPx, rowInsetPx, sentenceInsetPx } = TIMELINE_METRICS;
  const markerCenterPx = rowInsetPx + markerPx / 2;
  return (
    <Row gap="medium" align="flex-start" style={{ paddingVertical: rowInsetPx }}>
      <Stack align="center" style={{ width: markerPx, alignSelf: 'stretch' }}>
        {first && last ? null : (
          <Stack
            style={{
              position: 'absolute',
              top: first ? markerCenterPx : 0,
              ...(last ? { height: markerCenterPx } : { bottom: 0 }),
              left: (markerPx - railPx) / 2,
              width: railPx,
              backgroundColor: theme.colors.divider,
            }}
          />
        )}
        <Stack
          align="center"
          justify="center"
          style={{
            width: markerPx,
            height: markerPx,
            borderRadius: markerPx / 2,
            backgroundColor: theme.colors.surface,
            borderWidth: railPx,
            borderColor: theme.colors.divider,
          }}
        >
          {content.glyph}
        </Stack>
      </Stack>
      <Stack gap="small" grow style={{ paddingTop: sentenceInsetPx }}>
        <Text variant="reading">
          {content.heading}
          {content.time === undefined || content.time === null ? null : '  '}
          {content.time}
        </Text>
        {content.body}
      </Stack>
      {content.trailing}
    </Row>
  );
}

/** A themed event rail over List's scrolling, accessibility and viewport ownership. */
export function Timeline<Item>({ renderItem, ...props }: TimelineProps<Item>): ReactElement {
  const lastIndex = props.items.length - 1;
  return (
    <List<Item>
      {...props}
      renderItem={(item: Item, index: number) => (
        <View role="listitem">
          <TimelineRow content={renderItem(item, index)} first={index === 0} last={index === lastIndex} />
        </View>
      )}
    />
  );
}
