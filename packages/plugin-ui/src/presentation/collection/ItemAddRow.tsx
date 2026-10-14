import type { ReactElement, ReactNode } from 'react';

import type { HappierItemDensity } from './semantics.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';

export type HappierItemAddRowContentProps = Readonly<{
  testID?: string;
  title: string;
  subtitle?: string;
  onPress: () => void;
  /** Controlled by the caller that owns the inline form. */
  expanded?: boolean;
  disabled?: boolean;
  showDivider?: boolean;
  density?: HappierItemDensity;
}>;

export type HappierItemAddRowRenderProps = Omit<HappierItemAddRowContentProps, 'expanded'> & Readonly<{
  icon: ReactNode;
  showChevron: false;
  accessibilityExpanded?: boolean;
}>;

export type HappierItemAddRowProps = HappierItemAddRowContentProps & Readonly<{
  renderIcon: (props: Readonly<{ name: 'plus'; size: number }>) => ReactNode;
  renderRow: (props: HappierItemAddRowRenderProps) => ReactElement;
}>;

/** One add-row composition; adapters bind their existing row, glyph and theme owners. */
export function HappierItemAddRow({ expanded, renderIcon, renderRow, ...props }: HappierItemAddRowProps): ReactElement {
  return renderRow({
    ...props,
    icon: renderIcon({ name: 'plus', size: HAPPIER_PAGE_METRICS.rowIconGlyphPx }),
    showChevron: false,
    ...(expanded === undefined ? {} : { accessibilityExpanded: expanded }),
  });
}
