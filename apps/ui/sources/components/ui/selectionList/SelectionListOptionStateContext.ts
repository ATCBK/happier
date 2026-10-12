import * as React from 'react';

/**
 * The interaction state of the option row an accessory renders in: under the pointer, or the
 * keyboard's focused row. A row's quiet secondary controls (a favorite star) can stay hidden until
 * the person reaches the row. `null` outside a selection list row.
 */
export type SelectionListOptionState = Readonly<{
  hovered: boolean;
  focused: boolean;
}>;

export const SelectionListOptionStateContext =
  React.createContext<SelectionListOptionState | null>(null);
