import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { useIsInsideItemSection } from '@/components/ui/lists/sectionLeadingColumn';
import { t } from '@/text';

/**
 * A row for an Action that is waiting on an approval, with one button to open it. Inside a section it
 * takes the sheet's own padding and edge; placed directly on a page it brings its own sheet. The
 * originating Action continuation owns settlement.
 */
export const ActionApprovalPendingNotice = React.memo(function ActionApprovalPendingNotice(props: Readonly<{
    message: string;
    onOpenApproval: () => void;
    /** What is waiting, in the approval's own words ("Write docs/getting-started.md in d-dc-hello-world."). */
    summary?: string | null;
    /**
     * `row` (default): a sheet row. `inline`: one quiet line for a host's own bar (the Code bar), so the
     * page doesn't move when an approval starts or settles.
     */
    presentation?: 'row' | 'inline';
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const page = useListPresentation() === 'page';
    const inSection = useIsInsideItemSection();
    const summary = props.summary?.trim().replace(/[.]$/u, '') || null;
    // Inline, the line takes whatever room its host bar has left: it names the file when it fits,
    // then only that it waits, then only Review. It never wraps or pushes the bar taller.
    const [room, setRoom] = React.useState<number | null>(null);
    const onRoomLayout = React.useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setRoom((previous) => (previous === next ? previous : next));
    }, []);
    if (props.presentation === 'inline') {
        const label = summary ? `${summary} · ${t('approvals.waitingForYou')}` : t('approvals.waitingForYou');
        const tier = room === null ? 'full' : room >= INLINE_FULL_MIN_PX ? 'full' : room >= INLINE_WAITING_MIN_PX ? 'waiting' : 'review';
        return (
            <View style={styles.inlineRoom} onLayout={onRoomLayout}>
            <HappierPressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={`${label}. ${t('approvals.review')}`}
                onPress={props.onOpenApproval}
                hitSlop={6}
                style={(state) => [
                    styles.inline,
                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                    state.pressed || state.hovered ? { backgroundColor: theme.colors.surface.pressed } : null,
                ]}
            >
                {/* Amber: it needs you. */}
                <Icon name="clock" size={ICON_SIZE.xs} color={theme.colors.state.warning.foreground} />
                {tier === 'review' ? null : (
                    <Text numberOfLines={1} style={styles.inlineText}>
                        {summary && tier === 'full' ? <Text style={styles.inlineSubject}>{summary}</Text> : null}
                        {summary && tier === 'full' ? ' · ' : null}
                        {t('approvals.waitingForYou')}
                    </Text>
                )}
                <Text style={styles.inlineAction}>{t('approvals.review')}</Text>
            </HappierPressable>
            </View>
        );
    }
    const row = (
        <Item
            testID={props.testID}
            mode="info"
            title={summary ?? props.message}
            subtitle={summary ? t('approvals.waitingForYou') : undefined}
            subtitleLines={0}
            showChevron={false}
            rightElement={<RoundButton size="small" display="secondary" title={t('approvals.review')} onPress={props.onOpenApproval} />}
        />
    );
    // Placed straight on a configuration page, the row brings its own sheet so it keeps the column.
    return page && !inSection ? <ItemGroup>{row}</ItemGroup> : row;
});

/** Room for a file name and the waiting line; below it the line drops the name, then the words. */
const INLINE_FULL_MIN_PX = 360;
const INLINE_WAITING_MIN_PX = 220;

const styles = StyleSheet.create((theme) => ({
    inlineRoom: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        justifyContent: 'flex-end',
    },
    // The pill never grows past its room: its words truncate inside it and Review stays inside the press target.
    inline: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s4,
        borderRadius: theme.borderRadius.md,
    },
    inlineText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
        minWidth: 0,
    },
    inlineSubject: {
        color: theme.colors.text.primary,
    },
    inlineAction: {
        flexShrink: 0,
        ...Typography.variant('meta'),
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
}));
