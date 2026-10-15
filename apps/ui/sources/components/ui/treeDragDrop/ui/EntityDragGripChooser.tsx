import * as React from 'react';
import type { HappierDropChooserSection } from '@happier-dev/plugin-ui/presentation';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';

const CHOOSER_MAX_WIDTH_PX = 480;

/**
 * The one Move chooser a drag grip opens. Its trigger is a small grip, so the menu is sized by its
 * own rows and never matched to the trigger's width (a grip-wide menu collapses to a sliver).
 */
export function EntityDragGripChooser(
  props: Readonly<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    sections: readonly HappierDropChooserSection[];
    onSelect: (optionId: string) => void;
    closeOnSelect?: boolean;
    trigger: React.ComponentProps<typeof DropdownMenu>['trigger'];
  }>,
): React.ReactElement {
  return (
    <DropdownMenu
      open={props.open}
      onOpenChange={props.onOpenChange}
      selectedId={null}
      {...(props.closeOnSelect === undefined
        ? {}
        : { closeOnSelect: props.closeOnSelect })}
      matchTriggerWidth={false}
      // Places are listed under the container they are in ("Home", a group's name), so two rows that read alike
      // still say which place they mean.
      showCategoryTitles
      // "Move below New in PRs & Issues · Capacity" names a real destination: the menu is as wide as its longest
      // row (the overlay still clamps it to the room), not the 320 px default that ellipsized it.
      maxWidthCap={CHOOSER_MAX_WIDTH_PX}
      items={props.sections.flatMap((section) =>
        section.options.map((option) => ({
          id: option.id,
          title: option.label,
          subtitle: option.detail,
          disabled: option.disabled,
          category: section.title,
        })),
      )}
      onSelect={props.onSelect}
      trigger={props.trigger}
    />
  );
}
