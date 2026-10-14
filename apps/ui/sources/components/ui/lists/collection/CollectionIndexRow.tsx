import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';

import { collectionListStyles } from './CollectionList';

/**
 * A rail's first row, "All …": the collection's index page. It is selected at the collection's root
 * route, where the homepage stands beside the list, and opens that root from any item. One drawing
 * for every settings collection, so each index row has the same mark, inset and selection.
 */
export const CollectionIndexRow = React.memo(function CollectionIndexRow(props: Readonly<{
    testID: string;
    /** The index named for what the collection holds ("All machines"). */
    title: string;
    /** A quiet fact at the row's end (what needs a look). */
    detail?: string;
    /** A pinned destination beside the index (Skills: Found on your machines) draws its own glyph. */
    icon?: IconName;
    selected: boolean;
    onPress: () => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <Item
            testID={props.testID}
            title={props.title}
            detail={props.detail}
            icon={(
                <HappierCollectionListMark>
                    <Icon name={props.icon ?? 'squares-four'} size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
            selected={props.selected}
            density="compact"
            showChevron={false}
            pressableStyle={collectionListStyles.row}
            onPress={props.onPress}
        />
    );
});
