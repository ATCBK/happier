import * as React from 'react';
import { Platform, View } from 'react-native';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { t } from '@/text';
import type { useHunkReviewController } from './hunkReview/useHunkReviewController';

export type ChangedFilesReviewLineTarget = Readonly<{ filePath: string; lineId: string }>;

function ChangedFilesReviewHunkNavigation({ controller }: Readonly<{
    controller: ReturnType<typeof useHunkReviewController>;
}>) {
    const count = controller.reviewUnits.length;
    const move = (direction: -1 | 1) => {
        if (direction === 1 && controller.currentIndex < count - 1) controller.next();
        if (direction === -1 && controller.currentIndex > 0) controller.previous();
    };
    if (count < 2) return null;
    return (
        <>
            <IconButton
                testID="scm-review-previous-hunk"
                accessibilityLabel={t('files.reviewPreviousHunk')}
                disabled={controller.currentIndex <= 0}
                onPress={() => move(-1)}
                variant="plain"
                size={28}
                interactiveTargetGapPx={2}
                iconSize={16}
                iconName="caret-up"
                tooltip={t('files.reviewPreviousHunk')}
            />
            <IconButton
                testID="scm-review-next-hunk"
                accessibilityLabel={t('files.reviewNextHunk')}
                disabled={controller.currentIndex >= count - 1}
                onPress={() => move(1)}
                variant="plain"
                size={28}
                interactiveTargetGapPx={2}
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
    controller: ReturnType<typeof useHunkReviewController>;
}>) {
    if (props.paths.length === 0) return null;
    const index = Math.max(0, props.activePath ? props.paths.indexOf(props.activePath) : 0);
    const move = (direction: -1 | 1) => {
        if (!props.paths[index + direction]) return;
        if (direction === 1) props.controller.nextFile();
        else props.controller.previousFile();
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
                    size={28}
                interactiveTargetGapPx={2}
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
                    size={28}
                interactiveTargetGapPx={2}
                    iconSize={16}
                    iconName="caret-right"
                    tooltip={t('files.reviewNextFile')}
                />
            ) : null}
            <ChangedFilesReviewHunkNavigation
                controller={props.controller}
            />
        </View>
    );
}
