import * as React from 'react';
import type { HappierDropChooserSection } from '@happier-dev/plugin-ui/presentation';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';

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
