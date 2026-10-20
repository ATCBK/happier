import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';

/**
 * A flat pane section's heading: the title with its count, and the section's one control ("+") at the
 * end, on the inset the pane's Discussions heading uses so every section of a pane shares one edge.
 */
export function PaneSectionHeader(props: Readonly<{
    title: string;
    count?: number;
    action?: React.ReactNode;
    testID?: string;
}>) {
    return (
        <View style={styles.header} testID={props.testID}>
            <View style={styles.label}>
                <CollectionListGroupLabel title={props.title} count={props.count} />
            </View>
            {props.action}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    header: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, paddingLeft: theme.space.s8, paddingRight: theme.space.s8 },
    label: { flex: 1, minWidth: 0 },
}));
