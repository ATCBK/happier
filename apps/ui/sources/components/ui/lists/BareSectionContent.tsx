import * as React from 'react';
import { View } from 'react-native';

import { useBareRowBleedPx } from './bareRowBleed';

/**
 * Free content in a bare section (`ItemGroup surface="none"`): the section bleeds past the column by its row inset so
 * its rows' press fill and dividers reach into the padding, and a row brings its own inset back. Content that is not
 * a row (a details head, numbered steps, a button row) has none, so it takes the inset here and stands on the
 * column's edge with the section titles around it.
 */
export function BareSectionContent(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    const bleedPx = useBareRowBleedPx();
    return bleedPx > 0 ? <View style={{ paddingHorizontal: bleedPx }}>{props.children}</View> : <>{props.children}</>;
}
