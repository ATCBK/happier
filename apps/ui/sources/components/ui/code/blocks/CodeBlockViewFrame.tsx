import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { HorizontalOverflowScrollView } from '@/components/ui/scroll/HorizontalOverflowScrollView';
import { resolveCodeMonoFontFamily } from '../codeTypography';
import { CopyIconButton, COPY_ICON_BUTTON_WIDTH } from '@/components/ui/copy/CopyIconButton';
import { resolveHappierCodeBlockLayout } from '@happier-dev/plugin-ui/presentation';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';

export type CodeBlockViewFrameProps = Readonly<{
    code: string;
    language?: string | null;
    showHeaderRow?: boolean;
    selectable?: boolean;
    wrap?: boolean;
    showCopyButton?: boolean;
    headerLeft?: React.ReactNode;
    headerRight?: React.ReactNode;
    scrollTestID?: string;
    containerStyle?: StyleProp<ViewStyle>;
    children: React.ReactNode;
}>;

/** Placement around the copy button's platform-sized press frame. */
const COPY_BUTTON_OVERLAY_OFFSET = 8;
/**
 * How far the code's viewport stops short of the block's right edge while the copy button is overlaid,
 * so a command scrolls or wraps beside the button instead of running under it.
 */
export const CODE_BLOCK_OVERLAY_COPY_INSET = COPY_BUTTON_OVERLAY_OFFSET
    + COPY_ICON_BUTTON_WIDTH;

export const CodeBlockViewFrame = React.memo<CodeBlockViewFrameProps>(({
    code,
    language = null,
    showHeaderRow = true,
    selectable = true,
    wrap = false,
    showCopyButton = false,
    headerLeft,
    headerRight,
    scrollTestID,
    containerStyle,
    children,
}) => {
    const { theme } = useUnistyles();
    const behavior = resolveHappierCodeBlockLayout({
        language,
        showHeaderRow,
        showCopyButton,
        hasHeaderLeft: Boolean(headerLeft),
        hasHeaderRight: Boolean(headerRight),
    });
    const shouldRenderHeaderRow = behavior.shouldRenderHeaderRow;
    const shouldOverlayCopyButton = behavior.shouldOverlayCopyButton;
    const contentPaddingStyle = shouldOverlayCopyButton
        ? [styles.codePadding]
        : (shouldRenderHeaderRow ? styles.codePaddingWithHeader : styles.codePadding);
    const besideOverlaidCopy = showCopyButton && shouldOverlayCopyButton ? styles.besideOverlaidCopy : null;

    const copyButton = showCopyButton ? (
        <CopyIconButton
            text={code}
            variant={shouldOverlayCopyButton ? 'outlined' : 'plain'}
            style={shouldOverlayCopyButton ? styles.copyButtonOverlay : null}
        />
    ) : null;

    const header = shouldRenderHeaderRow ? (
        <View style={styles.headerRow}>
            <View style={styles.headerLeft}>
                {headerLeft ? (
                    headerLeft
                ) : behavior.language ? (
                    <Text selectable={selectable} style={[styles.headerText, { color: theme.colors.text.secondary }]}>
                        {behavior.language}
                    </Text>
                ) : (
                    <View />
                )}
            </View>
            <View style={styles.headerRight}>
                {headerRight}
                {copyButton}
            </View>
        </View>
    ) : null;

    return (
        <View
            // Selection sources (Ask about a transcript code block) find the block they sit in.
            {...(Platform.OS === 'web' ? { dataSet: { happierCodeBlock: 'true' } } : {})}
            style={[
                styles.container,
                showCopyButton && shouldOverlayCopyButton ? styles.containerWithOverlaidCopy : null,
                { backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.inset, 'content', true), borderColor: theme.colors.border.default },
                containerStyle,
            ]}
        >
            {header}
            {shouldOverlayCopyButton ? copyButton : null}
            {wrap ? (
                <View style={[contentPaddingStyle, besideOverlaidCopy]}>
                    {children}
                </View>
            ) : (
                <HorizontalOverflowScrollView
                    keepNativeTextSelection={!showCopyButton}
                    testID={scrollTestID}
                    showsHorizontalScrollIndicator={false}
                    style={[styles.scroll, besideOverlaidCopy]}
                    contentContainerStyle={contentPaddingStyle}
                >
                    {children}
                </HorizontalOverflowScrollView>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        alignSelf: 'stretch',
        borderRadius: theme.parts.codeBlock.radius,
        borderWidth: 1,
        overflow: 'hidden',
        position: 'relative',
    },
    containerWithOverlaidCopy: {
        // Keep the entire physical press target inside the block's clipping boundary.
        minHeight: COPY_BUTTON_OVERLAY_OFFSET * 2 + COPY_ICON_BUTTON_WIDTH,
    },
    scroll: {
        width: '100%',
        alignSelf: 'stretch',
    },
    besideOverlaidCopy: {
        width: 'auto',
        marginRight: CODE_BLOCK_OVERLAY_COPY_INSET,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 12,
        paddingVertical: 4,
    },
    headerLeft: {
        flex: 1,
        minWidth: 0,
        paddingRight: 8,
    },
    headerText: {
        fontFamily: resolveCodeMonoFontFamily(),
        fontSize: 12,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    copyButtonOverlay: {
        position: 'absolute',
        top: COPY_BUTTON_OVERLAY_OFFSET,
        right: COPY_BUTTON_OVERLAY_OFFSET,
        zIndex: 10,
    },
    codePadding: {
        paddingHorizontal: 12,
        paddingVertical: 12,
    },
    codePaddingWithHeader: {
        paddingHorizontal: 12,
        paddingTop: 4,
        paddingBottom: 12,
    },
}));
