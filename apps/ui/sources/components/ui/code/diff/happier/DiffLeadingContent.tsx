import * as React from 'react';
import { View } from 'react-native';

import { DiffHunkRowViewportContext } from '../hunks/DiffHunkRow';

/**
 * Content inside a code column that scrolls sideways but does not belong to the code's width: a diff's
 * leading content above the first line, or what renders under a line (an inline comment composer). It is
 * held to the visible width while the code scrolls sideways (as change rows are), so an image compare or a
 * composer's Save never stretches to the longest line or slides with it.
 */
export function DiffLeadingContent(props: Readonly<{
    children: React.ReactNode;
    /** The code column's own side padding (both sides together), which the visible width also holds. */
    inset?: number;
}>) {
    const viewport = React.useContext(DiffHunkRowViewportContext);
    return (
        <View style={viewport ? { width: Math.max(0, viewport.width - (props.inset ?? 0)), transform: [{ translateX: viewport.offsetX }] } : null}>
            {props.children}
        </View>
    );
}
