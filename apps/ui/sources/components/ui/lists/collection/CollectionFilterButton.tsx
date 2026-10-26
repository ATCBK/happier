import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { t } from '@/text';

/**
 * A saved-space list's filter button (lab `clfilter:filter`): the funnel that opens the condition editor,
 * with the shared count badge while conditions narrow the list beyond its space. Sessions puts it beside
 * Find; Workflows and Discussions in their header actions.
 */
export const CollectionFilterButton = React.memo(function CollectionFilterButton(
  props: Readonly<{
    testID: string;
    activeCount: number;
    open: boolean;
    onPress: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const label =
    props.activeCount > 0
      ? t('sessionsList.filterButtonActive', { count: props.activeCount })
      : t('sessionsList.filterButton');
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      expanded={props.open}
      hasPopup="dialog"
      onPress={props.onPress}
      style={(state) => [
        {
          width: 30,
          height: 30,
          borderRadius: 8,
          alignItems: 'center',
          justifyContent: 'center',
        },
        props.open || state.hovered || state.pressed
          ? { backgroundColor: theme.colors.surface.selected }
          : null,
      ]}
    >
      <Icon name="funnel-simple" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
      {props.activeCount > 0 ? (
        <TabBadge variant="count" tone="neutral" value={props.activeCount} style={{ top: -1, right: -2 }} />
      ) : null}
    </HappierPressable>
  );
});
