import { createContext } from 'react';

/** The row owns placement; its field box consumes that placement without a second fit decision. */
export type HappierPageRowFieldLayout = Readonly<{
  maxWidthPx: number | null;
  stacked: boolean;
}>;

export const HappierPageRowFieldLayoutContext = createContext<HappierPageRowFieldLayout | null>(null);
