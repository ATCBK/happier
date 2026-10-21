import * as React from 'react';
import { View } from 'react-native';

import { DiffHunkRowViewportContext } from '../hunks/DiffHunkRow';

/**
 * A diff's leading content as the Happier renderers place it above the first line: inside the vertical
 * scroller, but held to the visible width while the code scrolls sideways (as change rows are), so an
 * image compare never stretches to the longest line or slides with it.
 */
export function DiffLeadingContent(props: Readonly<{ children: React.ReactNode }>) {
    const viewport = React.useContext(DiffHunkRowViewportContext);
    return (
        <View style={viewport ? { width: viewport.width, transform: [{ translateX: viewport.offsetX }] } : null}>
            {props.children}
        </View>
    );
}
