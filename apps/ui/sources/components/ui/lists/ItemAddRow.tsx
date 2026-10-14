import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierItemAddRow, type HappierItemAddRowContentProps } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';

/**
 * The one "add" row of a settings sheet ("Add env var", "Add variable", "Add model", "New role"): a plus
 * glyph in the row's leading column, in the item ink, and the title in the row's own type. It opens an
 * inline form or the add flow; it never carries a chevron.
 */
export const ItemAddRow = React.memo(function ItemAddRow(
  props: HappierItemAddRowContentProps,
) {
  const { theme } = useUnistyles();
  return (
    <HappierItemAddRow
      {...props}
      renderIcon={(icon) => <Icon {...icon} color={theme.colors.text.secondary} />}
      renderRow={({ accessibilityExpanded, ...row }) => <Item {...row}
        {...(accessibilityExpanded === undefined ? {} : { accessibilityState: { expanded: accessibilityExpanded } })}
      />}
    />
  );
});
