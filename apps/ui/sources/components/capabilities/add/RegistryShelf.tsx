import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import {
  Collection,
  type CollectionAnatomy,
  useHappierCollection,
} from '@happier-dev/plugin-ui';
import type { RegistryItemSummaryV1 } from '@happier-dev/protocol/registries';

import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';

/** Three cards across the homepage column (lab hs A2/A3, hm A2). */
const SHELF_SIZE = 3;
const SHELF_CARD_MIN_WIDTH_PX = 200;
/** The homepage is the scroller: the shelf's grid draws none of its own. */
const passThroughScroller = (children: React.ReactNode) => children;

export type RegistryShelfCard = RegistryItemSummaryV1;
const NO_OPEN = () => {};

export function registryShelfCardKey(item: RegistryShelfCard): string {
  return `${item.sourceId}:${item.itemId}`;
}

/**
 * A capability homepage's registry shelf (P4's one suggestions rule, IR-79): three cards in a Collection
 * grid that fill the row at any column width, each with its Add. The homepage supplies the words under a
 * card's name and its action; no items, no shelf (never an empty one).
 */
export const RegistryShelf = React.memo(function RegistryShelf(
  props: Readonly<{
    testID: string;
    title: string;
    description?: string;
    items: readonly RegistryShelfCard[];
    loading: boolean;
    /** The quiet line under the card's name (a publisher, a repository, the source). */
    where: (card: RegistryShelfCard) => string | null;
    glyph?: (card: RegistryShelfCard) => React.ReactNode;
    action: (card: RegistryShelfCard) => React.ReactNode;
    columnTitle: string;
    /** "Browse all": opens the kind's Add modal on Browse. */
    browseAll?: Readonly<{ label: string; onPress: () => void }>;
  }>,
) {
  const cards = React.useMemo(
    () => props.items.slice(0, SHELF_SIZE),
    [props.items],
  );
  const model = useHappierCollection<RegistryShelfCard>({
    items: cards,
    keyOf: registryShelfCardKey,
    // A shelf opens nothing in place: each card's own action adds it.
    openKey: null,
    onOpenChange: NO_OPEN,
  });
  const [width, setWidth] = React.useState(0);
  const onLayout = React.useCallback(
    (event: LayoutChangeEvent) =>
      setWidth(Math.round(event.nativeEvent.layout.width)),
    [],
  );
  const gutter = HAPPIER_PAGE_METRICS.sheetInsetPx;
  // Three cards fill the row at any column width (never a fourth, empty slot), down to the card's minimum.
  const minCardWidth = Math.max(
    SHELF_CARD_MIN_WIDTH_PX,
    Math.floor((width - 2 * gutter - (SHELF_SIZE - 1) * gutter) / SHELF_SIZE) -
      1,
  );
  const { where, glyph, action, columnTitle, testID } = props;
  const anatomy = React.useMemo(
    (): CollectionAnatomy<RegistryShelfCard> => ({
      glyph: (card) => glyph?.(card) ?? null,
      title: (card) => card.title,
      where,
      description: (card) => card.description ?? null,
      action,
      columnTitles: { title: columnTitle },
      accessibilityLabel: (card) => card.title,
      testID: (card) => `${testID}.${card.itemId}`,
    }),
    [action, columnTitle, glyph, testID, where],
  );
  if (cards.length === 0) return null;
  return (
    <ItemGroup
      title={props.title}
      {...(props.description ? { description: props.description } : {})}
      surface="none"
      {...(props.browseAll
        ? { action: <SectionActionButton testID={`${testID}.browseAll`} title={props.browseAll.label} icon="magnifying-glass" onPress={props.browseAll.onPress} /> }
        : {})}
    >
      {/* The card grid draws its own gutter inside the section's content: the shelf pulls that gutter back out so the cards stand on the page's sheet edge, the legend's (lab hm-A2). */}
      <View onLayout={onLayout} style={{ marginHorizontal: -gutter }}>
        <CoreCollectionScope renderPageScroller={passThroughScroller}>
          <Collection<RegistryShelfCard>
            testID={testID}
            model={model}
            anatomy={anatomy}
            accessibilityLabel={props.title}
            presentation="grid"
            detail="none"
            scroll="page"
            minListWidth={SHELF_CARD_MIN_WIDTH_PX}
            minDetailWidth={SHELF_CARD_MIN_WIDTH_PX}
            preferredListRatio={1}
            minCardWidth={minCardWidth}
            loading={props.loading && cards.length === 0}
          />
        </CoreCollectionScope>
      </View>
    </ItemGroup>
  );
});
