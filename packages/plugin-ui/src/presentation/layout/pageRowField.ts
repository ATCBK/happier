import { createContext } from 'react';

/** The row owns placement; its field box consumes that placement without a second fit decision. */
export type HappierPageRowFieldLayout = Readonly<{
  maxWidthPx: number | null;
  stacked: boolean;
  /**
   * The field box reports that its value filled the room beside the label (`maxWidthPx`), so the row
   * moves the field beneath where the value reads in full (`resolveHappierPageRowFieldMaxWidth`).
   */
  onFieldSaturated?: (maxWidthPx: number) => void;
}>;

export const HappierPageRowFieldLayoutContext = createContext<HappierPageRowFieldLayout | null>(null);
