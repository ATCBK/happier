import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';

/**
 * The one "add" row of a settings sheet ("Add env var", "Add variable", "Add model", "New role"): a plus
 * glyph in the row's leading column, in the item ink, and the title in the row's own type. It opens an
 * inline form or the add flow; it never carries a chevron.
 */
export const ItemAddRow = React.memo(function ItemAddRow(
  props: Readonly<{
    testID?: string;
    title: string;
    subtitle?: string;
    onPress: () => void;
    /** For a row that opens an inline form under itself: whether that form is open. */
    expanded?: boolean;
    disabled?: boolean;
    showDivider?: boolean;
    density?: React.ComponentProps<typeof Item>['density'];
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <Item
      testID={props.testID}
      title={props.title}
      subtitle={props.subtitle}
      icon={<Icon name="plus" color={theme.colors.text.secondary} />}
      onPress={props.onPress}
      showChevron={false}
      disabled={props.disabled}
      density={props.density}
      {...(props.showDivider !== undefined
        ? { showDivider: props.showDivider }
        : {})}
      {...(props.expanded !== undefined
        ? { accessibilityState: { expanded: props.expanded } }
        : {})}
    />
  );
});
