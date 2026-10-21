import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

/**
 * The main column's composer, as the pane host sees it: a pane presented inside the session column
 * (lab AR1 EFv) covers the column down to the composer's top edge, so the composer stays in reach.
 */
export const PaneMainComposerReporterContext = React.createContext<((node: View | null) => void) | null>(null);

/** The main column's composer band; reports itself to the enclosing pane host on every layout. */
export function PaneMainComposerAnchor(props: Readonly<{ style?: StyleProp<ViewStyle>; children: React.ReactNode }>): React.ReactElement {
    const report = React.useContext(PaneMainComposerReporterContext);
    const ref = React.useRef<View | null>(null);
    const onLayout = React.useCallback(() => report?.(ref.current), [report]);
    React.useEffect(() => () => report?.(null), [report]);
    return <View ref={ref} onLayout={onLayout} style={props.style}>{props.children}</View>;
}
