import * as React from 'react';

/**
 * Set by a page `Item` around its select field (`fieldAccessory`) when the row is a narrow pane column
 * (not a phone): the widest the field may get beside the label's column. The field then drops from the
 * shared column width to its content width, within this bound, and stays trailing its label.
 * `null` (default): the field keeps its own span.
 */
export const PageRowFieldWidthContext = React.createContext<number | null>(
  null,
);
