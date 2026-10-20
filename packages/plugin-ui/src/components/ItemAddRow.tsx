import type { ReactElement } from 'react';

import { HappierItemAddRow, type HappierItemAddRowContentProps } from '../presentation/collection/ItemAddRow.js';
import { PluginUiIconGlyph } from './Icon.js';
import { Item } from './List.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type ItemAddRowProps = HappierItemAddRowContentProps;

/** A sheet's add action, sharing the host's plus, disclosure and row composition. */
export function ItemAddRow(props: ItemAddRowProps): ReactElement {
  const theme = usePluginTheme();
  return <HappierItemAddRow {...props}
    renderIcon={({ size }) => <PluginUiIconGlyph name="add" size={size} color={theme.colors.secondaryText} />}
    renderRow={({ showChevron: _showChevron, ...row }) => <Item {...row} />}
  />;
}
