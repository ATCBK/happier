import * as React from 'react';
import { View } from 'react-native';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { Modal } from '@/modal';

type ComparisonProps = Readonly<{ oldText: string; newText: string; filePath: string; subtitle: string }>;

function TextComparisonModal(props: ComparisonProps) {
    return (
        <View style={{ flex: 1, minHeight: 240 }}>
            <DiffViewer mode="text" oldText={props.oldText} newText={props.newText} filePath={props.filePath} wrapLines showLineNumbers showPrefix />
        </View>
    );
}

/** Read-only comparison of two text snapshots; the caller owns their meaning. */
export function showTextComparison(props: ComparisonProps) {
    Modal.show({
        component: TextComparisonModal,
        props,
        chrome: {
            kind: 'card',
            title: props.filePath,
            subtitle: props.subtitle,
            scrollHost: 'body',
            bodyScroll: 'none',
            dimensions: { width: 900, maxHeightRatio: 0.85, size: 'lg' },
        },
    });
}
