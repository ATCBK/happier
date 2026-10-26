import * as React from 'react';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';

/**
 * The Discussion page's Details tab: the same operations the header's ⋯ menu lists on a phone, as rows.
 * A toggled policy (the check-in) is a switch saying what applies now; the rest are operations, in the
 * menu's own order, so one owner decides what a Discussion offers.
 */
export function DiscussionDetailsPanel(
  props: Readonly<{ actions: readonly PageHeaderMenuAction[] }>,
): React.ReactElement {
  const settings = props.actions.filter(
    (action) => action.checked !== undefined || action.category !== undefined,
  );
  const operations = props.actions.filter(
    (action) => action.checked === undefined && action.category === undefined,
  );
  return (
    <ItemList testID="discussion-details-tab">
      {settings.length > 0 ? (
        <ItemGroup>
          {settings.map((action) => (
            <Item
              key={action.id}
              testID={action.testID ? `${action.testID}-row` : undefined}
              title={action.title}
              subtitle={action.subtitle}
              disabled={action.disabled}
              loading={action.loading}
              rightElement={
                action.checked === undefined ? undefined : (
                  <Switch
                    testID={action.testID}
                    value={action.checked}
                    disabled={action.disabled}
                    accessibilityLabel={action.title}
                    onValueChange={() => void action.onSelect()}
                  />
                )
              }
              onPress={
                action.checked === undefined
                  ? () => void action.onSelect()
                  : undefined
              }
              showChevron={false}
            />
          ))}
        </ItemGroup>
      ) : null}
      {operations.length > 0 ? (
        <ItemGroup>
          {operations.map((action) => (
            <Item
              key={action.id}
              testID={action.testID}
              title={action.title}
              subtitle={action.subtitle}
              disabled={action.disabled}
              loading={action.loading}
              destructive={action.destructive}
              onPress={() => void action.onSelect()}
              showChevron={false}
            />
          ))}
        </ItemGroup>
      ) : null}
    </ItemList>
  );
}
