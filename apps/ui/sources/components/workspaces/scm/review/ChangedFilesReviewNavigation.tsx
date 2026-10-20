import * as React from 'react';
import { Platform, View } from 'react-native';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { t } from '@/text';
import type { ChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';
import { useDiffHunkTable } from '@/components/ui/code/diff/hunks/useDiffHunkTable';
import { useDiffHunkNavigation } from '@/components/ui/code/diff/hunks/useDiffHunkNavigation';

export type ChangedFilesReviewLineTarget = Readonly<{ filePath: string; lineId: string }>;

function ChangedFilesReviewHunkNavigation(props: Readonly<{
    filePath: string;
    diffStateSource: ChangedFilesReviewDiffStateSource;
    onFocusLine: (target: ChangedFilesReviewLineTarget | null) => void;
}>) {
    const state = React.useSyncExternalStore(
        React.useCallback((listener) => props.diffStateSource.subscribe(props.filePath, listener), [props.diffStateSource, props.filePath]),
        React.useCallback(() => props.diffStateSource.getDiffState(props.filePath), [props.diffStateSource, props.filePath]),
        React.useCallback(() => props.diffStateSource.getDiffState(props.filePath), [props.diffStateSource, props.filePath]),
    );
    const table = useDiffHunkTable({ mode: 'unified', filePath: props.filePath, unifiedDiff: state.diff });
    const navigation = useDiffHunkNavigation(table);
    React.useEffect(() => { props.onFocusLine(null); }, [props.filePath, props.onFocusLine, state.diff]);
    const move = (direction: -1 | 1) => {
        const lineId = direction === 1 ? navigation.next() : navigation.previous();
        if (lineId) props.onFocusLine({ filePath: props.filePath, lineId });
    };
    if (navigation.count < 2) return null;
    return (
        <>
            <IconButton
                testID="scm-review-previous-hunk"
                accessibilityLabel={t('files.reviewPreviousHunk')}
                disabled={!navigation.canPrevious}
                onPress={() => move(-1)}
                variant="plain"
                size={Platform.OS === 'web' ? 28 : 48}
                iconSize={16}
                iconName="caret-up"
                tooltip={t('files.reviewPreviousHunk')}
            />
            <IconButton
                testID="scm-review-next-hunk"
                accessibilityLabel={t('files.reviewNextHunk')}
                disabled={!navigation.canNext}
                onPress={() => move(1)}
                variant="plain"
                size={Platform.OS === 'web' ? 28 : 48}
                iconSize={16}
                iconName="caret-down"
                tooltip={t('files.reviewNextHunk')}
            />
        </>
    );
}

export function ChangedFilesReviewNavigation(props: Readonly<{
    paths: readonly string[];
    activePath: string | null;
    onFocusPath: (path: string) => void;
    diffStateSource: ChangedFilesReviewDiffStateSource;
    onFocusLine: (target: ChangedFilesReviewLineTarget | null) => void;
}>) {
    if (props.paths.length === 0) return null;
    const index = Math.max(0, props.activePath ? props.paths.indexOf(props.activePath) : 0);
    const move = (direction: -1 | 1) => {
        const path = props.paths[index + direction];
        if (path) props.onFocusPath(path);
    };
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            {props.paths.length > 1 ? (
                <IconButton
                    testID="scm-review-previous-file"
                    accessibilityLabel={t('files.reviewPreviousFile')}
                    disabled={index === 0}
                    onPress={() => move(-1)}
                    variant="plain"
                    size={Platform.OS === 'web' ? 28 : 48}
                    iconSize={16}
                    iconName="caret-left"
                    tooltip={t('files.reviewPreviousFile')}
                />
            ) : null}
            {props.paths.length > 1 ? (
                <IconButton
                    testID="scm-review-next-file"
                    accessibilityLabel={t('files.reviewNextFile')}
                    disabled={index === props.paths.length - 1}
                    onPress={() => move(1)}
                    variant="plain"
                    size={Platform.OS === 'web' ? 28 : 48}
                    iconSize={16}
                    iconName="caret-right"
                    tooltip={t('files.reviewNextFile')}
                />
            ) : null}
            <ChangedFilesReviewHunkNavigation
                key={props.paths[index]}
                filePath={props.paths[index]}
                diffStateSource={props.diffStateSource}
                onFocusLine={props.onFocusLine}
            />
        </View>
    );
}
